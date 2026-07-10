import { STATUS_ABERTOS, type FotoResumo, type InstanciaDetalhe, type TipoFoto } from '@rhodes/shared';

import { montarFormFoto } from '../lib/foto';
import type { Submissao } from './db';
import {
  marcar,
  pendentesPorInstancia,
  registrarTentativa,
  remover,
} from './fila';

export type Resultado =
  | 'OK'
  | 'JA_APLICADO'
  | 'CONFLITO'
  | 'TRANSITORIO'
  | 'PERMANENTE'
  | 'NAO_AUTENTICADO';

export type ResumoFlush = {
  enviadas: number;
  jaAplicadas: number;
  conflitos: number;
  erros: number;
  pausado: boolean;
};

/** 401 no meio do túnel: a fila PAUSA e pede login — jamais descarta evidência. */
let pausadoPorAuth = false;
let rodando = false;

export function estaPausado(): boolean {
  return pausadoPorAuth;
}

/** Chamado após o re-login (S3). */
export function retomar(): void {
  pausadoPorAuth = false;
}

// --------------------------------------------------------------------------- envio

function fetchJson(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/**
 * `deviceNow` é SEMPRE o relógio do aparelho AGORA (no envio) — o servidor calcula
 * `skew_ms = servidor − deviceNow`, que mede drift de relógio. O `capturedAt` guardado na fila
 * (hora da foto) vai separado. Trocar um pelo outro envenenaria o antifraude (Onda 11) ou o
 * grau B (S6).
 */
function enviarFotoDaFila(sub: Submissao, agora: Date): Promise<Response> {
  // O Blob é remontado aqui: a fila guarda bytes (ver db.ts).
  const foto = new Blob([sub.bytes!], { type: sub.mime ?? 'image/jpeg' });
  const form = montarFormFoto(
    sub.payload.tipo as TipoFoto,
    foto,
    sub.exif ?? {},
    agora,
    sub.capturedAt,
  );
  return fetch(`/api/instancias/${sub.instanciaId}/fotos`, {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  });
}

function enviar(sub: Submissao, agora: Date, fotoImpedimentoId?: number): Promise<Response> {
  const base = `/api/instancias/${sub.instanciaId}`;
  switch (sub.acao) {
    case 'INICIAR':
      return fetchJson(`${base}/iniciar`);
    case 'FOTO':
      return enviarFotoDaFila(sub, agora);
    case 'PARTE':
      return fetchJson(`${base}/partes`, sub.payload);
    case 'CONCLUIR':
      return fetchJson(`${base}/concluir`);
    case 'JUSTIFICAR':
      return fetchJson(`${base}/justificar`, {
        ...sub.payload,
        ...(fotoImpedimentoId !== undefined ? { fotoImpedimentoId } : {}),
      });
  }
}

// --------------------------------------------------------------------------- reconciliação

/** `captured_at` volta do servidor truncado ao SEGUNDO (drizzle timestamp). Comparar assim. */
function mesmoSegundo(a: string, b: string): boolean {
  return Math.floor(Date.parse(a) / 1000) === Math.floor(Date.parse(b) / 1000);
}

/**
 * A ação já está aplicada no servidor? (retry cujo 1º envio deu certo mas a resposta se perdeu)
 * Verificamos o ESTADO REAL da instância — nunca a mensagem de erro, que é texto humano.
 */
function jaAplicada(sub: Submissao, d: InstanciaDetalhe, eu: string): boolean {
  switch (sub.acao) {
    case 'INICIAR':
      return d.status === 'IN_PROGRESS' && d.executanteLogin === eu;
    case 'FOTO':
      return d.fotos.some(
        (f) => f.tipo === sub.payload.tipo && sub.capturedAt !== undefined && mesmoSegundo(f.capturedAt, sub.capturedAt),
      );
    case 'PARTE':
      return d.partes.some((p) => p.percentualAcumulado === sub.payload.percentualAcumulado);
    case 'CONCLUIR':
      return d.status.startsWith('DONE') && d.executanteLogin === eu;
    case 'JUSTIFICAR':
      return d.status === 'MISSED' && d.justificativa !== null;
  }
}

/** Outro executante fechou/tomou a tarefa enquanto eu estava sem sinal. */
function conflita(d: InstanciaDetalhe, eu: string): boolean {
  const fechada = !(STATUS_ABERTOS as readonly string[]).includes(d.status);
  const deOutro = d.executanteLogin !== null && d.executanteLogin !== eu;
  return fechada || deOutro;
}

/**
 * 4xx ambíguo (409/403/400) → busca o estado real e decide. É o coração da idempotência:
 * o `sha256` UNIQUE no servidor impede a duplicata; aqui só traduzimos o "não" dele.
 */
async function reconciliar(sub: Submissao, eu: string): Promise<Resultado> {
  const res = await fetch(`/api/instancias/${sub.instanciaId}`, { credentials: 'same-origin' });
  if (res.status === 401) return 'NAO_AUTENTICADO';
  if (!res.ok) return 'TRANSITORIO'; // não deu para saber — tenta de novo depois
  const detalhe = (await res.json()) as InstanciaDetalhe;

  if (jaAplicada(sub, detalhe, eu)) return 'JA_APLICADO';
  if (conflita(detalhe, eu)) return 'CONFLITO';
  return 'PERMANENTE'; // instância aberta e minha, mas o servidor recusou → payload ruim
}

async function classificar(res: Response, sub: Submissao, eu: string): Promise<Resultado> {
  if (res.ok) return 'OK';
  if (res.status === 401) return 'NAO_AUTENTICADO';
  if (res.status >= 500) return 'TRANSITORIO';
  if (res.status === 400 || res.status === 403 || res.status === 409) {
    return reconciliar(sub, eu);
  }
  return 'PERMANENTE'; // 413/415 e afins: payload que nunca vai passar
}

// --------------------------------------------------------------------------- worker

/**
 * Envia as pendências. Por instância, EM ORDEM, parando a cadeia no primeiro resultado que não é
 * avanço (concluir depende da foto, que depende do iniciar). Reentrante-safe.
 */
export async function flush(opts: { meuLogin: string; agora?: Date }): Promise<ResumoFlush> {
  const resumo: ResumoFlush = { enviadas: 0, jaAplicadas: 0, conflitos: 0, erros: 0, pausado: pausadoPorAuth };
  if (pausadoPorAuth || rodando) return resumo;
  rodando = true;
  try {
    const agora = opts.agora ?? new Date();
    const grupos = await pendentesPorInstancia();

    for (const cadeia of grupos.values()) {
      // ids das fotos enviadas nesta cadeia — o JUSTIFICAR amarra a foto de IMPEDIMENTO
      const fotoIdPorSubmissao = new Map<number, number>();

      for (const sub of cadeia) {
        if (sub.proximaTentativaEm !== undefined && sub.proximaTentativaEm > agora.getTime()) break;

        const refId = sub.refFotoSubmissaoId;
        const fotoImpedimentoId = refId !== undefined ? fotoIdPorSubmissao.get(refId) : undefined;

        let res: Response;
        try {
          res = await enviar(sub, agora, fotoImpedimentoId);
        } catch (err) {
          // Rede caiu — OU um bug de payload. Não dá para distinguir (o fetch rejeita com TypeError
          // nos dois casos), então guardamos a mensagem: um erro que não passa nunca fica visível no
          // indicador (S3) em vez de virar retry eterno e silencioso.
          await registrarTentativa(sub.id!, sub.tentativas, agora, (err as Error).message);
          break;
        }

        const resultado = await classificar(res, sub, opts.meuLogin);

        if (resultado === 'NAO_AUTENTICADO') {
          pausadoPorAuth = true;
          resumo.pausado = true;
          return resumo; // nada é descartado; a fila espera o re-login
        }
        if (resultado === 'OK') {
          if (sub.acao === 'FOTO') {
            const foto = (await res.json()) as FotoResumo;
            fotoIdPorSubmissao.set(sub.id!, foto.id);
          }
          await remover(sub.id!);
          resumo.enviadas += 1;
          continue;
        }
        if (resultado === 'JA_APLICADO') {
          await remover(sub.id!);
          resumo.jaAplicadas += 1;
          continue;
        }
        if (resultado === 'CONFLITO') {
          await marcar(sub.id!, 'CONFLITO', 'A tarefa foi fechada ou assumida por outra pessoa.');
          resumo.conflitos += 1;
          break; // o resto da cadeia depende desta
        }
        if (resultado === 'PERMANENTE') {
          const corpo = (await res.json().catch(() => null)) as { erro?: string } | null;
          await marcar(sub.id!, 'ERRO', corpo?.erro ?? `Erro ${res.status}`);
          resumo.erros += 1;
          break;
        }
        // TRANSITORIO
        await registrarTentativa(sub.id!, sub.tentativas, agora);
        break;
      }
    }
    return resumo;
  } finally {
    rodando = false;
  }
}

/**
 * Dispara o flush ao voltar o sinal, ao reabrir o app e num intervalo leve.
 * **Sem Background Sync API** — não existe no iOS (decisão da arquitetura). Devolve o cleanup.
 */
export function iniciarSyncAutomatico(meuLogin: string, intervaloMs = 30_000): () => void {
  // Sem rede não adianta tentar — e tentar queimaria o backoff à toa dentro do silo.
  const disparar = (): void => {
    if (navigator.onLine === false) return;
    void flush({ meuLogin });
  };
  const aoVoltarAoApp = (): void => {
    if (document.visibilityState === 'visible') disparar();
  };

  window.addEventListener('online', disparar);
  document.addEventListener('visibilitychange', aoVoltarAoApp);
  const timer = window.setInterval(disparar, intervaloMs);
  disparar();

  return () => {
    window.removeEventListener('online', disparar);
    document.removeEventListener('visibilitychange', aoVoltarAoApp);
    window.clearInterval(timer);
  };
}

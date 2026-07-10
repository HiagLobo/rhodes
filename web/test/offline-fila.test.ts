// @vitest-environment jsdom
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanciaDetalhe } from '@rhodes/shared';

import { montarFormFoto } from '../src/lib/foto';
import {
  contarPendentes,
  contarPorEstado,
  daInstancia,
  enfileirar,
  limpar,
} from '../src/offline/fila';
import { estaPausado, flush, retomar } from '../src/offline/sync';

const EU = 'executante.teste';
const INST = 7;
const CAPTURA = '2026-07-09T12:00:00.456Z'; // com milissegundos
const CAPTURA_SERVIDOR = '2026-07-09T12:00:00.000Z'; // o servidor trunca ao segundo

function jpeg(): Blob {
  return new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
}

/** A fila guarda BYTES, não Blob (ver db.ts) — o Blob é remontado no envio. */
function bytesJpeg(): ArrayBuffer {
  return new Uint8Array([0xff, 0xd8, 0xff]).buffer;
}

function resposta(status: number, corpo: unknown = {}): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(corpo) } as Response;
}

function detalhe(over: Partial<InstanciaDetalhe>): InstanciaDetalhe {
  return {
    status: 'IN_PROGRESS',
    executanteLogin: EU,
    fotos: [],
    partes: [],
    justificativa: null,
    ...over,
  } as unknown as InstanciaDetalhe;
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function mockFetch(handler: Handler) {
  const chamadas: { url: string; metodo: string; body?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      chamadas.push({ url: String(url), metodo: init?.method ?? 'GET', body: init?.body });
      return Promise.resolve(handler(String(url), init));
    }),
  );
  return chamadas;
}

beforeEach(async () => {
  retomar();
  await limpar();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fila offline', () => {
  it('preserva a ordem da cadeia por instância (iniciar → foto → concluir)', async () => {
    await enfileirar({ instanciaId: INST, acao: 'INICIAR', payload: {} });
    await enfileirar({ instanciaId: INST, acao: 'FOTO', payload: { tipo: 'ANTES' }, bytes: bytesJpeg(), mime: 'image/jpeg', capturedAt: CAPTURA });
    await enfileirar({ instanciaId: INST, acao: 'CONCLUIR', payload: {} });
    // outra instância não interfere na numeração
    await enfileirar({ instanciaId: 99, acao: 'INICIAR', payload: {} });

    const cadeia = await daInstancia(INST);
    expect(cadeia.map((s) => s.acao)).toEqual(['INICIAR', 'FOTO', 'CONCLUIR']);
    expect(cadeia.map((s) => s.ordem)).toEqual([1, 2, 3]);
    expect((await daInstancia(99))[0]!.ordem).toBe(1);
    expect(await contarPendentes()).toBe(4);
  });

  it('409 de foto duplicada → tratado como SUCESSO (reconciliação pelo estado real)', async () => {
    await enfileirar({ instanciaId: INST, acao: 'INICIAR', payload: {} });
    await enfileirar({ instanciaId: INST, acao: 'FOTO', payload: { tipo: 'ANTES' }, bytes: bytesJpeg(), mime: 'image/jpeg', capturedAt: CAPTURA });

    mockFetch((url, init) => {
      if (init?.method === 'POST') return resposta(409, { erro: 'mensagem humana qualquer' });
      // GET do detalhe: a tarefa é minha, está em execução e a foto JÁ está lá
      return resposta(
        200,
        detalhe({
          status: 'IN_PROGRESS',
          fotos: [{ tipo: 'ANTES', capturedAt: CAPTURA_SERVIDOR }] as InstanciaDetalhe['fotos'],
        }),
      );
    });

    const r = await flush({ meuLogin: EU });
    expect(r.jaAplicadas).toBe(2);
    expect(r.conflitos).toBe(0);
    expect(await contarPendentes()).toBe(0); // nada ficou preso
  });

  it('409 em tarefa fechada por OUTRO → CONFLITO e a cadeia para', async () => {
    await enfileirar({ instanciaId: INST, acao: 'CONCLUIR', payload: {} });
    await enfileirar({ instanciaId: INST, acao: 'JUSTIFICAR', payload: { motivo: 'CHUVA' } });

    mockFetch((url, init) => {
      if (init?.method === 'POST') return resposta(409, { erro: 'Instância já fechada.' });
      return resposta(200, detalhe({ status: 'DONE_ON_TIME', executanteLogin: 'outro.executante' }));
    });

    const r = await flush({ meuLogin: EU });
    expect(r.conflitos).toBe(1);

    const cadeia = await daInstancia(INST);
    expect(cadeia[0]!.estado).toBe('CONFLITO');
    expect(cadeia[1]!.estado).toBe('PENDENTE'); // a cadeia parou; nada foi descartado
    expect((await contarPorEstado()).CONFLITO).toBe(1);
  });

  it('401 pausa a fila e NÃO descarta nada', async () => {
    await enfileirar({ instanciaId: INST, acao: 'INICIAR', payload: {} });
    mockFetch(() => resposta(401, { erro: 'sessão expirada' }));

    const r = await flush({ meuLogin: EU });
    expect(r.pausado).toBe(true);
    expect(estaPausado()).toBe(true);
    expect(await contarPendentes()).toBe(1);

    // enquanto pausada, nem tenta
    const chamadas = mockFetch(() => resposta(200));
    await flush({ meuLogin: EU });
    expect(chamadas.length).toBe(0);
  });

  it('5xx é transitório (backoff, permanece); 400 sem efeito aplicado vira ERRO', async () => {
    const agora = new Date('2026-07-09T12:00:00Z');

    await enfileirar({ instanciaId: INST, acao: 'INICIAR', payload: {} });
    mockFetch(() => resposta(503));
    await flush({ meuLogin: EU, agora });
    let s = (await daInstancia(INST))[0]!;
    expect(s.estado).toBe('PENDENTE');
    expect(s.tentativas).toBe(1);
    expect(s.proximaTentativaEm).toBeGreaterThan(agora.getTime());

    await limpar();
    await enfileirar({ instanciaId: INST, acao: 'PARTE', payload: { percentualAcumulado: 50 } });
    mockFetch((url, init) => {
      if (init?.method === 'POST') return resposta(400, { erro: 'O percentual precisa avançar.' });
      return resposta(200, detalhe({ partes: [] })); // aberta, minha, e a parte NÃO existe
    });
    const r = await flush({ meuLogin: EU, agora });
    expect(r.erros).toBe(1);
    s = (await daInstancia(INST))[0]!;
    expect(s.estado).toBe('ERRO');
    expect(s.ultimoErro).toBe('O percentual precisa avançar.');
  });

  it('o JUSTIFICAR amarra o id da foto de IMPEDIMENTO enviada antes dele', async () => {
    const idFoto = await enfileirar({
      instanciaId: INST,
      acao: 'FOTO',
      payload: { tipo: 'IMPEDIMENTO' },
      bytes: bytesJpeg(),
      mime: 'image/jpeg',
      capturedAt: CAPTURA,
    });
    await enfileirar({
      instanciaId: INST,
      acao: 'JUSTIFICAR',
      payload: { motivo: 'CHUVA' },
      refFotoSubmissaoId: idFoto,
    });

    const chamadas = mockFetch((url) => {
      if (url.endsWith('/fotos')) return resposta(201, { id: 99 });
      return resposta(200, { proximaDue: null });
    });

    const r = await flush({ meuLogin: EU });
    expect(r.enviadas).toBe(2);

    const justificar = chamadas.find((c) => c.url.endsWith('/justificar'))!;
    expect(JSON.parse(String(justificar.body))).toEqual({ motivo: 'CHUVA', fotoImpedimentoId: 99 });
  });
});

describe('montarFormFoto — captura ≠ envio', () => {
  it('offline: capturedAt é a hora da FOTO e deviceNow é a hora do ENVIO', () => {
    // Se estes dois colassem, ou o skew explodiria (parece relógio adulterado, Onda 11)
    // ou o captured_at viraria a hora do envio (mata o grau B, S6).
    const envio = new Date('2026-07-09T15:00:00.000Z');
    const form = montarFormFoto('ANTES', jpeg(), {}, envio, '2026-07-09T12:00:00.000Z');
    expect(form.get('capturedAt')).toBe('2026-07-09T12:00:00.000Z');
    expect(form.get('deviceNow')).toBe('2026-07-09T15:00:00.000Z');
  });

  it('online (sem capturedAt explícito e sem EXIF): captura = envio, como antes', () => {
    const agora = new Date('2026-07-09T15:00:00.000Z');
    const form = montarFormFoto('DEPOIS', jpeg(), {}, agora);
    expect(form.get('capturedAt')).toBe(agora.toISOString());
    expect(form.get('deviceNow')).toBe(agora.toISOString());
  });
});

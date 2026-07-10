import Dexie, { type Table } from 'dexie';

import type { ExifExtraido } from '../lib/foto';

/** As ações do executante que a fila carrega — na ordem em que o backend as exige. */
export type AcaoOffline = 'INICIAR' | 'FOTO' | 'PARTE' | 'CONCLUIR' | 'JUSTIFICAR';

/**
 * `PENDENTE` = a enviar. `ERRO` = 4xx permanente (payload ruim) — não adianta reenviar.
 * `CONFLITO` = a instância foi fechada/tomada por OUTRO enquanto o aparelho estava offline;
 * o trabalho não se perde: a S5 o transforma em registro anexo para o gestor.
 */
export type EstadoSubmissao = 'PENDENTE' | 'ERRO' | 'CONFLITO';

export type Submissao = {
  id?: number;
  instanciaId: number;
  acao: AcaoOffline;
  /** Monotônica POR INSTÂNCIA: iniciar → foto → … → concluir. A cadeia é dependente. */
  ordem: number;
  /** Dados da ação (tipo da foto, motivo/texto, percentual…). Serializável. */
  payload: Record<string, unknown>;
  /**
   * Bytes da foto JÁ COMPRIMIDA (nunca o original de 10 MB). Só em FOTO.
   *
   * Guardamos `ArrayBuffer`, **não `Blob`**: `Blob` dentro do IndexedDB tem histórico de bugs no
   * Safari/iOS (a arquitetura já trata o iOS como restrição) e nem todo runtime faz clone estruturado
   * dele. `ArrayBuffer` clona em qualquer lugar. O `Blob` é remontado na hora do envio.
   */
  bytes?: ArrayBuffer;
  mime?: string;
  exif?: ExifExtraido;
  /** Hora da CAPTURA — não do envio. É o que dá o "grau B" (S6) sem envenenar o skew. */
  capturedAt?: string;
  /** Para o JUSTIFICAR amarrar a foto de IMPEDIMENTO enfileirada antes dele. */
  refFotoSubmissaoId?: number;
  criadoEm: string;
  tentativas: number;
  /** Backoff: não tentar antes deste instante (epoch ms). */
  proximaTentativaEm?: number;
  estado: EstadoSubmissao;
  ultimoErro?: string;
};

export class BancoOffline extends Dexie {
  submissoes!: Table<Submissao, number>;

  constructor(nome: string) {
    super(nome);
    this.version(1).stores({
      // ++id = auto; os demais são índices (o composto serve à leitura em ordem por instância)
      submissoes: '++id, instanciaId, estado, [instanciaId+ordem]',
    });
  }
}

/**
 * Fila offline do executante (Onda 10/S2) — IndexedDB via Dexie.
 *
 * Guarda só SUBMISSÕES DE SAÍDA (o que ainda não chegou ao servidor). Nenhuma resposta de `/api/*`
 * é persistida aqui: evidência e PII não podem ser servidas de cache, e leitura velha não pode virar
 * verdade (ALCOA+ "Contemporâneo").
 */
export const db = new BancoOffline('rhodes-offline');

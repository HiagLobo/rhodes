import { z } from 'zod';

import { dataOperacionalSchema, diffDias, type InstanceStatus } from './agendamento.js';
import type { JustificativaStatus } from './justificativa.js';
import type { ScoreResultado } from './score.js';

/**
 * Dossiê de auditoria em PDF (Onda 09). Esta é a CAMADA DE DADOS (S1): contrato do que o dossiê
 * carrega, montado em lote por `montarDossieDados` (server) e testável sem PDF. Nenhum `path` de
 * filesystem entra aqui (LGPD/imutável 3) — a foto é identificada por `sha256`/`id`; o binário e o
 * caminho são resolvidos SÓ no servidor (S2/S3). O hash canônico (S1) protege a evidência.
 */

// --------------------------------------------------------------------------- filtros (borda Zod)

/**
 * Boolean à prova de querystring: a query manda a string `'true'`/`'false'`, e o cliente (S4) só
 * anexa o parâmetro quando ligado. NUNCA usar `z.coerce.boolean` — converteria a string `'false'`
 * em `true`. `preprocess` aceita tanto boolean (testes) quanto string (rota) e cai em `false` no
 * ausente.
 */
const flagQuerystringSchema = z.preprocess((v) => v === true || v === 'true', z.boolean());

/**
 * areaIds pode chegar como CSV `'1,2,3'` (querystring), array repetido `['1','2']` (Fastify) ou
 * array de números (testes). Tokens vazios/não-positivos são descartados (Number('')===0 não pode
 * derrubar o parse), e string vazia (`areaIds=`) vira ausência de filtro, não 400.
 */
const areaIdsSchema = z.preprocess((v) => {
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return undefined;
    return s
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  if (Array.isArray(v)) {
    return v.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  return v;
}, z.array(z.number().int().positive()));

/** Teto de 186 dias corridos = a "6 meses" da meta (não meses de calendário). */
export const RELATORIO_MAX_DIAS = 186;

export const relatorioFiltrosSchema = z
  .object({
    inicio: dataOperacionalSchema,
    fim: dataOperacionalSchema,
    areaIds: areaIdsSchema.optional(),
    roundId: z.coerce.number().int().positive().optional(),
    somenteReprovadasOuCriticas: flagQuerystringSchema,
  })
  .refine((f) => f.fim >= f.inicio, {
    message: 'O fim do período não pode ser antes do início.',
    path: ['fim'],
  })
  .refine((f) => diffDias(f.inicio, f.fim) <= RELATORIO_MAX_DIAS, {
    message: `O período não pode exceder ${RELATORIO_MAX_DIAS} dias (~6 meses).`,
    path: ['fim'],
  });

export type RelatorioFiltros = z.infer<typeof relatorioFiltrosSchema>;

// --------------------------------------------------------------------------- conformidade

/** Balde de conformidade por instância (padrão "Won't do"): os 6 INSTANCE_STATUS mapeiam aqui. */
export const CONFORMIDADE_CLASSES = [
  'NO_PRAZO',
  'ATRASADA',
  'JUSTIFICADA',
  'PERDIDA',
  'EM_ABERTO',
] as const;

export type ConformidadeClasse = (typeof CONFORMIDADE_CLASSES)[number];

export type ConformidadeArea = {
  areaId: number;
  areaNome: string;
  noPrazo: number;
  atrasadas: number;
  justificadas: number;
  perdidas: number;
  emAberto: number;
  total: number;
};

// --------------------------------------------------------------------------- página de evidência

/** Metadados de UMA foto na página de evidência — SEM `path` (só id/sha256/tempos do servidor). */
export type FotoEvidenciaDossie = {
  id: number;
  tipo: string; // ANTES | DEPOIS | IMPEDIMENTO
  parte: number;
  sha256: string;
  receivedAt: string; // ISO do SERVIDOR
  capturedAt: string;
  skewMs: number;
};

/** Vínculo navio/lote (SHIP). "lote" = `produto` (não há coluna lote). */
export type NavioLote = {
  roundId: number;
  navio: string;
  produto: string | null;
  tonelagem: number | null;
  etaDate: string;
};

/** Vistoria da execução — "assinatura" é a re-autenticação (texto), não rubrica gráfica. */
export type EvidenciaInspecao = {
  resultado: string; // APROVADA | REPROVADA
  vistoriador: string;
  criadoEm: string;
  severidade: string | null;
  motivo: string | null;
  /** Observação livre do vistoriador (motivo escrito da reprovação) — prova impressa. */
  texto: string | null;
  amostral: boolean;
};

export type EvidenciaPagina = {
  instanceId: number;
  areaId: number;
  areaNome: string;
  atividade: string;
  /** Frequência EXPLÍCITA (elemento de auditor). */
  frequency: string;
  intervalDays: number;
  dueDate: string;
  windowEnd: string;
  statusFinal: InstanceStatus;
  conformidade: ConformidadeClasse;
  executante: string | null;
  finishedAt: string | null;
  /** Soma dos pares ANTES/DEPOIS; `null` sem par (instância em aberto). */
  tempoExecucaoSeg: number | null;
  /** POP VIGENTE do template (não há binding por execução — ver ESTADO/Pendências). */
  metodoVersao: string | null;
  fotos: FotoEvidenciaDossie[];
  inspecao: EvidenciaInspecao | null;
  navioLote: NavioLote | null;
};

// --------------------------------------------------------------------------- anexo + dossiê

export type JustificativaAnexo = {
  areaNome: string;
  atividade: string;
  motivo: string;
  texto: string | null;
  status: JustificativaStatus;
  criadoEm: string;
  decididoPor: string | null;
};

export type DossieDados = {
  periodo: { inicio: string; fim: string };
  /** Metadado — FORA do hash (determinismo). */
  geradoEm: string;
  responsaveis: string[];
  areas: { id: number; nome: string; peso: number }[];
  /**
   * Score do PERÍODO (KPI). Escopado às MESMAS áreas do filtro `areaIds` (todas se ausente); NÃO é
   * estreitado por `roundId` (o score não é métrica por rodada de navio) — a capa (S2) rotula o
   * escopo. `score`/`banda` são `null` em período/escopo sem dado.
   */
  score: ScoreResultado;
  /** true quando `fim < hoje`: a Cobertura do score é snapshot atual, não do período (ver ESTADO). */
  coberturaSnapshot: boolean;
  conformidade: ConformidadeArea[];
  /** Páginas de evidência (respeitam `somenteReprovadasOuCriticas`). */
  paginas: EvidenciaPagina[];
  justificativas: JustificativaAnexo[];
  /** SHA-256 canônico dos dados probatórios (rodapé + audit_log). */
  hash: string;
};

/** Uma linha do histórico de relatórios gerados (lida do audit_log — S3). */
export type RelatorioHistoricoItem = {
  ator: string | null;
  criadoEm: string;
  filtros: RelatorioFiltros;
  nInstancias: number;
  hash: string;
  formato: string;
};

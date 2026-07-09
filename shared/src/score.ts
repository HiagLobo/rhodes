import { z } from 'zod';

import type { Classificacao } from './justificativa.js';
import type { InstanceStatus } from './agendamento.js';
import type { InspecaoResultado, Severidade } from './vistoria.js';

/**
 * Score Rhodes 0–100 (Onda 08, cold start). Fórmula reduzida: Pontualidade + Aprovação +
 * Cobertura renormalizadas. TUDO que é parâmetro é DADO (imutável 7): a engine LÊ de
 * `ScoreConfig`; as constantes abaixo são só o FALLBACK de `lerScoreConfig`.
 */

// --------------------------------------------------------------------------- config (DADO)

export type ScoreConfig = {
  pesos: { pontualidade: number; aprovacao: number; cobertura: number };
  /** Graça da regra dos 10%: crédito cheio até r ≤ gracaPontualidade. */
  gracaPontualidade: number;
  demerito: { CRITICA: number; MAIOR: number; MENOR: number };
  tetoDemeritos: number;
  /** Acima deste % de justificativas por executante na janela, as externas excedentes → 0,5. */
  tetoJustificativasExecutantePct: number;
  /** Preservada de amostragem.ts — vive no MESMO JSON de score_config. */
  vistoriaAmostralPct: number;
};

/** Fallback do código quando não há linha em score_config (a vigente vem do banco na S2). */
export const DEFAULT_SCORE_CONFIG: ScoreConfig = {
  pesos: { pontualidade: 30, aprovacao: 25, cobertura: 15 },
  gracaPontualidade: 0.1,
  demerito: { CRITICA: 8, MAIOR: 3, MENOR: 0 },
  tetoDemeritos: 20,
  tetoJustificativasExecutantePct: 20,
  vistoriaAmostralPct: 10,
};

/**
 * Zod do JSON `valores` de score_config (imutável 7). `scoreConfigInputSchema` é o que a UI do
 * gestor (S5) envia — SEM `vistoriaAmostralPct`, que é mesclada no servidor a partir da linha
 * vigente (senão a amostragem da Onda 06 regride). Campos com default = tolerância a linhas
 * antigas que não os tinham.
 */
export const scoreConfigInputSchema = z.object({
  pesos: z.object({
    pontualidade: z.number().min(0).max(100),
    aprovacao: z.number().min(0).max(100),
    cobertura: z.number().min(0).max(100),
  }),
  gracaPontualidade: z.number().min(0).max(1).default(0.1),
  demerito: z.object({
    CRITICA: z.number().min(0).max(100),
    MAIOR: z.number().min(0).max(100),
    MENOR: z.number().min(0).max(100),
  }),
  tetoDemeritos: z.number().min(0).max(100).default(20),
  tetoJustificativasExecutantePct: z.number().min(0).max(100).default(20),
});

export const scoreConfigSchema = scoreConfigInputSchema.extend({
  vistoriaAmostralPct: z.number().min(0).max(100).default(10),
});

// --------------------------------------------------------------------------- bandas SQF

export const BANDAS_SCORE = ['EXCELENTE', 'BOM', 'ATENCAO', 'CRITICO'] as const;

export type BandaScore = (typeof BANDAS_SCORE)[number];

/**
 * Banda por LIMIARES CONTÍNUOS que particionam [0,100] sem buraco (score é float): 85,5 e
 * 95,5 caem em ATENCAO/BOM, não num vão. As cores vivem no theme (BANDAS).
 */
export function bandaDoScore(v: number): BandaScore {
  if (v >= 96) return 'EXCELENTE';
  if (v >= 86) return 'BOM';
  if (v >= 70) return 'ATENCAO';
  return 'CRITICO';
}

// --------------------------------------------------------------------------- entrada (eventos brutos)

export type EventoInstancia = {
  templateId: number;
  areaId: number;
  frequenciaDias: number;
  dueDate: string;
  finishedAt: Date | null;
  status: InstanceStatus;
  origin: string;
  executanteId: number | null;
  justificativa?: { classificacao: Classificacao | null; status: string };
};

export type EventoInspecao = {
  areaId: number;
  resultado: InspecaoResultado;
  /** A instância inspecionada tem reworkOfInstanceId nulo (não é retrabalho). */
  primeiraVistoria: boolean;
  dataRecife: string;
};

export type DemeritoInput = { areaId: number; severidade: Severidade; dataRecife: string };

/** Só CRITICA/MAIOR geram demérito (MENOR = 0 — decisão da onda). */
export const SEVERIDADES_DEMERITO = ['CRITICA', 'MAIOR'] as const;

/** Item da fila de confirmação: reprovação grave SEM demérito confirmado ainda. */
export type DemeritoPendente = {
  inspectionId: number;
  instanceId: number;
  areaId: number;
  areaNome: string;
  atividade: string;
  severidade: Severidade;
  vistoriador: string | null;
  criadoEm: string;
};

/** Demérito já confirmado (extrato). */
export type DemeritoConfirmado = {
  id: number;
  inspectionId: number;
  areaNome: string;
  severidade: Severidade;
  confirmadoPor: string | null;
  criadoEm: string;
};

export type AreaPeso = { areaId: number; nome: string; peso: number };

export type EntradaScore = {
  /** Instâncias cujo dueDate cai na janela. */
  instancias: EventoInstancia[];
  /** Inspeções cuja dataRecife cai na janela. */
  inspecoes: EventoInspecao[];
  /** Deméritos confirmados cuja dataRecife (do evento) cai na janela. */
  demeritos: DemeritoInput[];
  /** Templates ativos (para a cobertura — snapshot no fim). */
  templatesAtivos: { templateId: number; areaId: number }[];
  /** templateIds com instância vencida ABERTA no fim da janela. */
  templatesComVencidaAberta: Set<number>;
  areas: AreaPeso[];
};

// --------------------------------------------------------------------------- saída

/** Componente com n=0 tem `valor: null` (AUSENTE — não entra na renormalização). */
export type ComponenteScore = { valor: number | null; n: number };

export type ScoreEscopo = {
  score: number | null;
  banda: BandaScore | null;
  componentes: { pontualidade: ComponenteScore; aprovacao: ComponenteScore; cobertura: ComponenteScore };
  demeritos: number;
  /** n do denominador de pontualidade — o eixo amostral do score (base da incerteza). */
  n: number;
  incertezaMais: number | null;
  incertezaMenos: number | null;
  taxaJustificadas: number;
};

export type ScoreArea = ScoreEscopo & { areaId: number; nome: string };

export type ScoreResultado = ScoreEscopo & { areas: ScoreArea[] };

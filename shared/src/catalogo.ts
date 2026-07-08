import { z } from 'zod';

/** Frequências reais do checklist validado (arquitetura §2.1) — sem RRULE, por design. */
export const FREQUENCIAS = [
  'DIARIO',
  'SEMANAL',
  'QUINZENAL',
  'MENSAL',
  'BIMESTRAL',
  'SEMESTRAL',
] as const;

export const frequenciaSchema = z.enum(FREQUENCIAS);

export type Frequencia = z.infer<typeof frequenciaSchema>;

export const INTERVALO_DIAS: Record<Frequencia, number> = {
  DIARIO: 1,
  SEMANAL: 7,
  QUINZENAL: 14,
  MENSAL: 30,
  BIMESTRAL: 61,
  SEMESTRAL: 182,
};

/**
 * Regra dos 10% (PM compliance — arquitetura §4.2): tolerância default por frequência.
 * DIARIO 0 · SEMANAL 1 · QUINZENAL 1 · MENSAL 3 · BIMESTRAL 6 · SEMESTRAL 18.
 */
export function graceDefault(frequencia: Frequencia): number {
  return Math.round(INTERVALO_DIAS[frequencia] * 0.1);
}

/** FIXED = ancorado no calendário (diário/semanal); FLOATING = próxima a partir da conclusão. */
export const SCHEDULE_MODES = ['FIXED', 'FLOATING'] as const;
export const scheduleModeSchema = z.enum(SCHEDULE_MODES);
export type ScheduleMode = z.infer<typeof scheduleModeSchema>;

export const TRIGGER_TYPES = ['CALENDAR', 'SHIP_EVENT', 'HYBRID'] as const;
export const triggerTypeSchema = z.enum(TRIGGER_TYPES);
export type TriggerType = z.infer<typeof triggerTypeSchema>;

export const SHIP_PHASES = ['PRE_ARRIVAL', 'POST_OPERATION'] as const;
export const shipPhaseSchema = z.enum(SHIP_PHASES);
export type ShipPhase = z.infer<typeof shipPhaseSchema>;

// ------------------------- tipos públicos (respostas da API) -------------------------

export type Area = {
  id: number;
  nome: string;
  pesoCriticidade: number;
  ativo: boolean;
};

export type MetodoVersao = {
  id: number;
  versao: number;
  texto: string;
  criadoEm: string;
  criadoPor: string | null;
};

export type Procedimento = {
  id: number;
  areaId: number;
  atividade: string;
  frequency: Frequencia;
  intervalDays: number;
  scheduleMode: ScheduleMode;
  graceDays: number;
  triggerType: TriggerType;
  shipPhase: ShipPhase | null;
  leadDays: number | null;
  limitacoes: string | null;
  dependsOnTemplateId: number | null;
  ativo: boolean;
  metodoAtual: MetodoVersao | null;
};

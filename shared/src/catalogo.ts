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

export type ProcedimentoDetalhe = Procedimento & { historico: MetodoVersao[] };

// ------------------------- payloads da API do catálogo (S3) -------------------------

export const criarAreaSchema = z.object({
  nome: z.string().trim().min(1).max(120),
  pesoCriticidade: z.number().min(0.1).max(10).optional(),
});
export type CriarAreaPayload = z.infer<typeof criarAreaSchema>;

export const editarAreaSchema = z.object({
  pesoCriticidade: z.number().min(0.1).max(10),
});
export type EditarAreaPayload = z.infer<typeof editarAreaSchema>;

/** Campos operacionais editáveis do procedimento — o MÉTODO nunca entra aqui (é versionado). */
const camposOperacionais = {
  areaId: z.number().int().positive(),
  atividade: z.string().trim().min(1).max(500),
  frequency: frequenciaSchema,
  scheduleMode: scheduleModeSchema,
  graceDays: z.number().int().min(0).max(60),
  triggerType: triggerTypeSchema,
  shipPhase: shipPhaseSchema.nullable(),
  leadDays: z.number().int().min(0).max(30).nullable(),
  limitacoes: z.string().trim().min(1).max(1000).nullable(),
};

export const criarProcedimentoSchema = z.object({
  ...camposOperacionais,
  scheduleMode: scheduleModeSchema.optional(),
  graceDays: camposOperacionais.graceDays.optional(),
  triggerType: triggerTypeSchema.optional(),
  shipPhase: shipPhaseSchema.nullable().optional(),
  leadDays: camposOperacionais.leadDays.optional(),
  limitacoes: camposOperacionais.limitacoes.optional(),
  metodo: z.string().trim().min(1).max(5000),
});
export type CriarProcedimentoPayload = z.infer<typeof criarProcedimentoSchema>;

export const editarProcedimentoSchema = z
  .object({
    areaId: camposOperacionais.areaId.optional(),
    atividade: camposOperacionais.atividade.optional(),
    frequency: frequenciaSchema.optional(),
    scheduleMode: scheduleModeSchema.optional(),
    graceDays: camposOperacionais.graceDays.optional(),
    triggerType: triggerTypeSchema.optional(),
    shipPhase: shipPhaseSchema.nullable().optional(),
    leadDays: camposOperacionais.leadDays.optional(),
    limitacoes: camposOperacionais.limitacoes.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nada para editar.' });
export type EditarProcedimentoPayload = z.infer<typeof editarProcedimentoSchema>;

export const novaVersaoMetodoSchema = z.object({
  texto: z.string().trim().min(1).max(5000),
});
export type NovaVersaoMetodoPayload = z.infer<typeof novaVersaoMetodoSchema>;

/** Modo default por frequência (mesma regra do seed): rotinas curtas ancoram no calendário. */
export function scheduleModeDefault(frequencia: Frequencia): ScheduleMode {
  return frequencia === 'DIARIO' || frequencia === 'SEMANAL' ? 'FIXED' : 'FLOATING';
}

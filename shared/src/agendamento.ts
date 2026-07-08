import { z } from 'zod';

import type { Frequencia, TriggerType } from './catalogo.js';

/**
 * Estados de uma instância de tarefa (Onda 03). OVERDUE é MATERIALIZADO pelo dailyJob —
 * a leitura nunca calcula atraso (imutável 4). MISSED = substituída sem execução
 * (justificável a partir da Onda 05).
 */
export const INSTANCE_STATUS = [
  'PENDING',
  'IN_PROGRESS',
  'OVERDUE',
  'DONE_ON_TIME',
  'DONE_LATE',
  'MISSED',
] as const;

export const instanceStatusSchema = z.enum(INSTANCE_STATUS);

export type InstanceStatus = z.infer<typeof instanceStatusSchema>;

/** Fonte única do que conta como "aberta" — trava do banco e queries usam esta lista. */
export const STATUS_ABERTOS = ['PENDING', 'IN_PROGRESS', 'OVERDUE'] as const;

export const INSTANCE_ORIGINS = ['CALENDAR', 'SHIP'] as const;

export const instanceOriginSchema = z.enum(INSTANCE_ORIGINS);

export type InstanceOrigin = z.infer<typeof instanceOriginSchema>;

// ---------------------------------------------------------------------------
// Datas de agendamento: dia operacional em America/Recife como 'YYYY-MM-DD'.
// Comparável lexicograficamente, legível no banco, imune a bug de fuso.
// Helpers PUROS — o instante sempre chega de fora (determinismo do motor).
// ---------------------------------------------------------------------------

const FORMATO_RECIFE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Recife',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Dia operacional (YYYY-MM-DD) em que um instante cai no fuso do porto. */
export function dataRecife(instante: Date): string {
  return FORMATO_RECIFE.format(instante);
}

/** Soma dias a uma data YYYY-MM-DD (meio-dia UTC internamente — sem bordas de fuso). */
export function somarDias(data: string, dias: number): string {
  const [y, m, d] = data.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + dias, 12)).toISOString().slice(0, 10);
}

/** Dias corridos de `de` até `ate` (positivo se `ate` é depois). */
export function diffDias(de: string, ate: string): number {
  const [y1, m1, d1] = de.split('-').map(Number);
  const [y2, m2, d2] = ate.split('-').map(Number);
  return Math.round((Date.UTC(y2!, m2! - 1, d2!) - Date.UTC(y1!, m1! - 1, d1!)) / 86_400_000);
}

/** Dia da semana de uma data YYYY-MM-DD (0=domingo … 6=sábado). */
export function diaDaSemana(data: string): number {
  const [y, m, d] = data.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12)).getUTCDay();
}

export const dataOperacionalSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato YYYY-MM-DD');

// ------------------------- tipos públicos (lista AGORA) -------------------------

export type InstanciaResumo = {
  id: number;
  templateId: number;
  areaId: number;
  areaNome: string;
  atividade: string;
  frequency: Frequencia;
  triggerType: TriggerType;
  dueDate: string;
  windowEnd: string;
  status: InstanceStatus;
  origin: InstanceOrigin;
  executanteLogin: string | null;
};

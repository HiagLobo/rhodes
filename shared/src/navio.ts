import { z } from 'zod';

import { dataOperacionalSchema } from './agendamento.js';

/** Máquina de estados da operação de navio (arquitetura §4.3) — sequência ESTRITA. */
export const NAVIO_STATUS = [
  'ANUNCIADO',
  'ATRACADO',
  'DESCARGA_INICIADA',
  'DESCARGA_CONCLUIDA',
  'DESATRACADO',
] as const;

export const navioStatusSchema = z.enum(NAVIO_STATUS);

export type NavioStatus = z.infer<typeof navioStatusSchema>;

/** Sem pular etapa, sem voltar — a única transição válida é a próxima da sequência. */
export function transicaoValida(de: NavioStatus, para: NavioStatus): boolean {
  return NAVIO_STATUS.indexOf(para) === NAVIO_STATUS.indexOf(de) + 1;
}

export function proximaTransicao(status: NavioStatus): NavioStatus | null {
  return NAVIO_STATUS[NAVIO_STATUS.indexOf(status) + 1] ?? null;
}

// ------------------------------- payloads da API -------------------------------

export const criarNavioSchema = z.object({
  navio: z.string().trim().min(1).max(120),
  produto: z.string().trim().min(1).max(120).optional(),
  tonelagem: z.number().positive().optional(),
  etaDate: dataOperacionalSchema,
});
export type CriarNavioPayload = z.infer<typeof criarNavioSchema>;

const instanteSchema = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Data/hora inválida (use ISO).');

export const transicaoNavioSchema = z.object({
  para: z.enum(['ATRACADO', 'DESCARGA_INICIADA', 'DESCARGA_CONCLUIDA', 'DESATRACADO']),
  /** Hora REAL do fato (retroativo permitido — navio atraca de madrugada). */
  eventAt: instanteSchema,
});
export type TransicaoNavioPayload = z.infer<typeof transicaoNavioSchema>;

export const editarEtaSchema = z.object({ etaDate: dataOperacionalSchema });
export type EditarEtaPayload = z.infer<typeof editarEtaSchema>;

// ------------------------------- tipos públicos -------------------------------

export type EventoNavio = {
  id: number;
  transicao: NavioStatus;
  eventAt: string;
  registeredAt: string;
  registradoPor: string;
  confirmado: boolean;
};

export type OperacaoNavio = {
  id: number;
  navio: string;
  produto: string | null;
  tonelagem: number | null;
  etaDate: string;
  status: NavioStatus;
  eventos: EventoNavio[];
};

export type RodadaResumo = { total: number; concluidas: number };

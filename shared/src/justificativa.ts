import { z } from 'zod';

/**
 * Justificativa estruturada (Onda 05/S3, modelo SMRP de deferral com reason code):
 * "não foi possível" SEMPRE tem motivo por código — nunca texto livre solto (imutável 8).
 * Nasce PENDENTE; o gestor decide na Onda 07 (aprovada externa sai do denominador do
 * score, interna vale crédito 0,5 — Onda 08).
 */
export const MOTIVOS_JUSTIFICATIVA = [
  'NAVIO_OPERANDO',
  'CHUVA',
  'AREA_INTERDITADA',
  'EQUIP_TERCEIRO',
  'FALTA_PESSOAL',
  'FALTA_MATERIAL',
  'OUTRO',
] as const;

export const motivoJustificativaSchema = z.enum(MOTIVOS_JUSTIFICATIVA);

export type MotivoJustificativa = z.infer<typeof motivoJustificativaSchema>;

/**
 * Dias que a PRÓXIMA instância adia a partir de hoje ao justificar — constante de
 * AGENDAMENTO (o efeito no score é outra coisa e vive em score_config, Onda 08).
 * Racional: impedimento curto (navio sai, chuva passa, escala volta) = 1 dia;
 * impedimento estrutural (interdição, equipamento/material de terceiro) = 2 dias.
 */
export const ADIAMENTO_POR_MOTIVO: Record<MotivoJustificativa, number> = {
  NAVIO_OPERANDO: 1,
  CHUVA: 1,
  FALTA_PESSOAL: 1,
  OUTRO: 1,
  AREA_INTERDITADA: 2,
  EQUIP_TERCEIRO: 2,
  FALTA_MATERIAL: 2,
};

export const justificarSchema = z
  .object({
    motivo: motivoJustificativaSchema,
    texto: z.string().trim().max(500).optional(),
    /** Foto tipo IMPEDIMENTO da MESMA instância (a rota valida). */
    fotoImpedimentoId: z.number().int().positive().optional(),
  })
  .refine((j) => j.motivo !== 'OUTRO' || (j.texto !== undefined && j.texto.length >= 10), {
    message: 'Motivo OUTRO exige descrever o que aconteceu (mínimo 10 caracteres).',
    path: ['texto'],
  });

export type JustificarPayload = z.infer<typeof justificarSchema>;

export const JUSTIFICATIVA_STATUS = ['PENDENTE', 'APROVADA', 'REPROVADA'] as const;

export type JustificativaStatus = (typeof JUSTIFICATIVA_STATUS)[number];

export type JustificativaResumo = {
  id: number;
  instanceId: number;
  motivo: MotivoJustificativa;
  texto: string | null;
  fotoId: number | null;
  status: JustificativaStatus;
  criadoPor: string | null;
  criadoEm: string;
};

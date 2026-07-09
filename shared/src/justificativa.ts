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

/**
 * Classificação da causa (Onda 07/S3) — persistida NA DECISÃO do gestor; a Onda 08 lê daqui:
 * EXTERNA aprovada sai do denominador do score; INTERNA vale crédito 0,5. Nunca reclassificar.
 */
export const CLASSIFICACOES = ['EXTERNA', 'INTERNA'] as const;

export const classificacaoSchema = z.enum(CLASSIFICACOES);

export type Classificacao = z.infer<typeof classificacaoSchema>;

/**
 * Classificação padrão por motivo. OUTRO é `null` — o gestor decide no ato de aprovar
 * (impedimento genérico pode ser dos dois lados).
 */
export const CLASSIFICACAO_POR_MOTIVO: Record<MotivoJustificativa, Classificacao | null> = {
  NAVIO_OPERANDO: 'EXTERNA',
  CHUVA: 'EXTERNA',
  AREA_INTERDITADA: 'EXTERNA',
  EQUIP_TERCEIRO: 'EXTERNA',
  FALTA_PESSOAL: 'INTERNA',
  FALTA_MATERIAL: 'INTERNA',
  OUTRO: null,
};

export const JUSTIFICATIVA_DECISOES = ['APROVADA', 'REPROVADA'] as const;

/**
 * Payload da decisão do gestor. `classificacao` só é aceita/obrigatória quando o motivo é
 * OUTRO e a decisão é APROVADA — mandar classificacao em motivo ≠ OUTRO é 400 (nada em
 * silêncio, coerência com o rigor do justificarSchema). O motivo NÃO vem no payload: a rota
 * lê da linha (imutável) para derivar a classificação padrão.
 */
export const decidirJustificativaSchema = z.object({
  decisao: z.enum(JUSTIFICATIVA_DECISOES),
  classificacao: classificacaoSchema.optional(),
  obs: z.string().trim().max(500).optional(),
});

export type DecidirJustificativaPayload = z.infer<typeof decidirJustificativaSchema>;

export type JustificativaResumo = {
  id: number;
  instanceId: number;
  motivo: MotivoJustificativa;
  texto: string | null;
  fotoId: number | null;
  status: JustificativaStatus;
  criadoPor: string | null;
  criadoEm: string;
  /** Preenchidos na decisão (Onda 07) — null enquanto PENDENTE. */
  classificacao: Classificacao | null;
  decididoPor: string | null;
  decididoEm: string | null;
  decisaoObs: string | null;
};

/** Item da fila de aprovação (com contexto da tarefa para o gestor decidir). */
export type JustificativaFilaItem = JustificativaResumo & {
  areaNome: string;
  atividade: string;
  dueDate: string;
};

/** Uma barra do Pareto de justificativas por motivo. */
export type ParetoMotivo = {
  motivo: MotivoJustificativa;
  total: number;
  pct: number;
};

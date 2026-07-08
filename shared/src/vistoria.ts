import { z } from 'zod';

/**
 * Vistoria (Onda 06) — a coluna "Revisão Rhodes" do checklist como fluxo digital.
 * Códigos de motivo/severidade nascem ESTÁVEIS: os deméritos do score (Onda 08) os referenciam.
 */
export const SEVERIDADES = ['MENOR', 'MAIOR', 'CRITICA'] as const;

export const severidadeSchema = z.enum(SEVERIDADES);

export type Severidade = z.infer<typeof severidadeSchema>;

/** Rubrica objetiva (pesquisa §3 — OSHA/FDA): pó >3 mm, mofo, infestação, resíduo visível. */
export const MOTIVOS_REPROVACAO = [
  'PO_RESIDUAL',
  'MOFO',
  'INFESTACAO',
  'RESIDUO_VISIVEL',
  'METODO_NAO_SEGUIDO',
  'OUTRO',
] as const;

export const motivoReprovacaoSchema = z.enum(MOTIVOS_REPROVACAO);

export type MotivoReprovacao = z.infer<typeof motivoReprovacaoSchema>;

/** Prazo do retrabalho (dias a partir de hoje): 24–48 h conforme a severidade. */
export const PRAZO_RETRABALHO_DIAS: Record<Severidade, number> = {
  MENOR: 2,
  MAIOR: 1,
  CRITICA: 1,
};

/** Assinatura eletrônica = senha do próprio vistoriador verificada NO ATO (S2). */
export const aprovarSchema = z.object({ senha: z.string().min(1) });

export type AprovarPayload = z.infer<typeof aprovarSchema>;

export const reprovarSchema = z
  .object({
    senha: z.string().min(1),
    motivo: motivoReprovacaoSchema,
    severidade: severidadeSchema,
    texto: z.string().trim().max(500).optional(),
    /** Foto da reprovação (tipo IMPEDIMENTO da mesma instância) — opcional. */
    fotoId: z.number().int().positive().optional(),
  })
  .refine((r) => r.motivo !== 'OUTRO' || (r.texto !== undefined && r.texto.length >= 10), {
    message: 'Motivo OUTRO exige descrever o problema (mínimo 10 caracteres).',
    path: ['texto'],
  });

export type ReprovarPayload = z.infer<typeof reprovarSchema>;

export const INSPECAO_RESULTADOS = ['APROVADA', 'REPROVADA'] as const;

export type InspecaoResultado = (typeof INSPECAO_RESULTADOS)[number];

export type InspecaoResumo = {
  id: number;
  instanceId: number;
  resultado: InspecaoResultado;
  motivo: MotivoReprovacao | null;
  severidade: Severidade | null;
  texto: string | null;
  amostral: boolean;
  vistoriador: string | null;
  criadoEm: string;
  retrabalhoInstanceId: number | null;
  /** Due do retrabalho quando reprovada — a UI mostra o prazo na hora. */
  retrabalhoDue: string | null;
};

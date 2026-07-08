import { z } from 'zod';

/**
 * Evidência fotográfica (Onda 05). ANTES/DEPOIS sustentam a conclusão; IMPEDIMENTO
 * acompanha justificativa. Foto nunca se apaga (ALCOA+) — não existe payload de exclusão.
 */
export const TIPOS_FOTO = ['ANTES', 'DEPOIS', 'IMPEDIMENTO'] as const;

export const tipoFotoSchema = z.enum(TIPOS_FOTO);

export type TipoFoto = z.infer<typeof tipoFotoSchema>;

/** Limite do upload — o cliente comprime para JPEG q0.8 (~300–800 KB); 10 MB é folga, não meta. */
export const FOTO_MAX_BYTES = 10 * 1024 * 1024;

const instanteSchema = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Data/hora inválida (use ISO).');

/**
 * Campos de formulário que acompanham o binário no multipart.
 * `capturedAt` = hora do disparo no DISPOSITIVO (EXIF DateTimeOriginal quando existir);
 * `deviceNow` = "agora" do dispositivo no envio — o servidor deriva o skew do relógio.
 * EXIF é extraído no CLIENTE antes da compressão (canvas apaga EXIF — arquitetura §6).
 */
export const uploadFotoCamposSchema = z.object({
  tipo: tipoFotoSchema,
  capturedAt: instanteSchema,
  deviceNow: instanteSchema,
  exifDatetime: z.string().trim().max(64).optional(),
  exifModel: z.string().trim().max(128).optional(),
});

export type UploadFotoCampos = z.infer<typeof uploadFotoCamposSchema>;

/** Shape público de uma foto — NUNCA expõe o path físico do servidor. */
export type FotoResumo = {
  id: number;
  instanceId: number;
  tipo: TipoFoto;
  parte: number;
  capturedAt: string;
  receivedAt: string;
  skewMs: number;
  exifDatetime: string | null;
  exifModel: string | null;
  tamanhoBytes: number;
  enviadoPor: string | null;
};

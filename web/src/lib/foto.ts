import exifr from 'exifr';
import type { FotoResumo, TipoFoto } from '@rhodes/shared';

import { ApiError } from './api';

export type ExifExtraido = {
  /** DateTimeOriginal em ISO — vira o capturedAt oficial quando existe. */
  capturedAt?: string;
  exifDatetime?: string;
  exifModel?: string;
};

/**
 * EXIF é lido ANTES de comprimir — o canvas apaga tudo (arquitetura §6).
 * Foto sem EXIF (ou parser falhando) não pode travar o fluxo de campo: devolve {}.
 */
export async function extrairExif(original: Blob): Promise<ExifExtraido> {
  try {
    const dados = (await exifr.parse(original, ['DateTimeOriginal', 'Make', 'Model'])) as
      | { DateTimeOriginal?: Date; Make?: string; Model?: string }
      | undefined;
    if (!dados) return {};
    const modelo = [dados.Make, dados.Model].filter(Boolean).join(' ').trim();
    return {
      capturedAt: dados.DateTimeOriginal?.toISOString(),
      exifDatetime: dados.DateTimeOriginal?.toISOString(),
      exifModel: modelo || undefined,
    };
  } catch {
    return {};
  }
}

/** JPEG q0.8 com maior lado ≤1920px (5–12 MB → 300–800 KB na rede do porto). */
export async function comprimirJpeg(original: Blob, ladoMax = 1920, qualidade = 0.8): Promise<Blob> {
  const bitmap = await createImageBitmap(original);
  const escala = Math.min(1, ladoMax / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * escala));
  canvas.height = Math.max(1, Math.round(bitmap.height * escala));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', qualidade),
  );
  if (!blob) throw new Error('Não consegui preparar a foto — tente de novo.');
  return blob;
}

/**
 * Monta o multipart do upload — separado para ser testável sem canvas/câmera.
 *
 * `agora` é o relógio do aparelho **no momento do ENVIO** (o servidor calcula
 * `skew_ms = servidor − deviceNow`, o drift do relógio — insumo antifraude da Onda 11).
 * `capturedAtExplicito` é a hora da **CAPTURA**: online os dois coincidem, mas na fila offline
 * (Onda 10) a foto é tirada horas antes de subir. Sem separar os dois, ou o skew explode (parece
 * relógio adulterado) ou o `captured_at` vira a hora do envio (mata o sinal de "grau B").
 */
export function montarFormFoto(
  tipo: TipoFoto,
  comprimida: Blob,
  exif: ExifExtraido,
  agora: Date,
  capturedAtExplicito?: string,
): FormData {
  const form = new FormData();
  // campos ANTES do binário — o servidor só enxerga fields que chegam antes do arquivo
  form.append('tipo', tipo);
  form.append('capturedAt', capturedAtExplicito ?? exif.capturedAt ?? agora.toISOString());
  form.append('deviceNow', agora.toISOString());
  if (exif.exifDatetime) form.append('exifDatetime', exif.exifDatetime);
  if (exif.exifModel) form.append('exifModel', exif.exifModel);
  form.append('arquivo', comprimida, 'foto.jpg');
  return form;
}

export type FotoPreparada = {
  comprimida: Blob;
  exif: ExifExtraido;
  /** Hora da CAPTURA (EXIF quando existe; senão o relógio do aparelho no momento da foto). */
  capturedAt: string;
};

/**
 * EXIF → comprime. Fica separada do envio para a fila offline (Onda 10/S2) guardar o payload já
 * pronto (nunca o original de 10 MB) e o `capturedAt` do momento certo.
 */
export async function prepararFoto(original: Blob, agora: Date = new Date()): Promise<FotoPreparada> {
  const exif = await extrairExif(original);
  const comprimida = await comprimirJpeg(original);
  return { comprimida, exif, capturedAt: exif.capturedAt ?? agora.toISOString() };
}

/** Pipeline completo do cliente: EXIF → comprime → envia (caminho online). */
export async function enviarFoto(
  instanciaId: number,
  tipo: TipoFoto,
  original: Blob,
): Promise<FotoResumo> {
  const { comprimida, exif, capturedAt } = await prepararFoto(original);
  const res = await fetch(`/api/instancias/${instanciaId}/fotos`, {
    method: 'POST',
    credentials: 'same-origin',
    body: montarFormFoto(tipo, comprimida, exif, new Date(), capturedAt),
  });
  if (!res.ok) {
    const corpo = (await res.json().catch(() => null)) as ApiError['corpo'];
    throw new ApiError(res.status, corpo);
  }
  return (await res.json()) as FotoResumo;
}

import fs from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';

/** Largura de IMPRESSÃO A4 da cópia de exibição (o thumb de 320px da Onda 05 é pequeno demais). */
const LARGURA_EXIBICAO = 900;

/** A cópia de exibição + se o binário REAL foi encontrado (false = placeholder cinza). */
export type ImagemExibicao = { buffer: Buffer; presente: boolean };

let placeholderCache: Promise<Buffer> | null = null;

/**
 * Placeholder cinza (memoizado) para foto ausente/corrompida — o dossiê NUNCA quebra por evidência
 * faltante (importa para o streaming da S3 não abortar no meio da resposta). Sempre idêntico, então
 * é gerado uma única vez.
 */
export function placeholderIndisponivel(): Promise<Buffer> {
  placeholderCache ??= sharp({ create: { width: 600, height: 400, channels: 3, background: '#d6d6d6' } })
    .jpeg({ quality: 55 })
    .toBuffer();
  return placeholderCache;
}

/**
 * Resolve a CÓPIA DE EXIBIÇÃO de uma foto (Onda 09/S2) a partir do `pathRelativo` JÁ RESOLVIDO pelo
 * servidor (a S3 lê `photos.path`; o path NUNCA vem do `DossieDados`). Redimensiona o ORIGINAL para
 * ~900px q75 via sharp — nunca embute o original em resolução plena (LGPD; marca d'água é Onda 11) e
 * nunca vaza o caminho. Arquivo ausente/inválido → `{presente:false}` com placeholder (o dossiê não
 * quebra, e o manifesto do PDF distingue evidência real de placeholder — ALCOA+ Exato).
 */
export async function resolverImagemExibicao(
  dataDir: string,
  pathRelativo: string,
): Promise<ImagemExibicao> {
  const original = path.join(dataDir, pathRelativo);
  if (!fs.existsSync(original)) return { buffer: await placeholderIndisponivel(), presente: false };
  try {
    const buffer = await sharp(original)
      .rotate() // respeita a orientação EXIF
      .resize({ width: LARGURA_EXIBICAO, withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();
    return { buffer, presente: true };
  } catch {
    return { buffer: await placeholderIndisponivel(), presente: false };
  }
}

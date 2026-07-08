import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import sharp from 'sharp';

/** Thumbnail mora ao lado do original: `<hash>.jpg` → `<hash>.thumb.jpg`. */
export function caminhoThumb(original: string): string {
  return original.replace(/\.jpg$/, '.thumb.jpg');
}

/** Geração em si — pura e testável; sharp usa o próprio pool de threads do libuv. */
export async function gerarThumbnail(origem: string, destino: string): Promise<void> {
  await sharp(origem)
    .rotate() // respeita a orientação EXIF
    .resize({ width: 320, withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toFile(destino);
}

const WORKER_URL = new URL('./thumbnail-worker.js', import.meta.url);

/**
 * Despacho FIRE-AND-FORGET: thumbnail falhar nunca falha o upload (o GET /thumb cai para o
 * original). Em produção (dist) roda em worker_threads — lote de fotos pós-navio não disputa
 * o event loop nem o pool do processo principal (decisão da arquitetura §"detalhes que a
 * crítica pegou"). Em dev/teste (fonte .ts, worker .js não existe) gera inline via sharp.
 */
export function agendarThumbnail(origem: string, aoFalhar?: (err: unknown) => void): void {
  const destino = caminhoThumb(origem);
  if (fs.existsSync(fileURLToPath(WORKER_URL))) {
    const worker = new Worker(WORKER_URL, { workerData: { origem, destino } });
    worker.on('error', (err) => aoFalhar?.(err));
    worker.unref();
    return;
  }
  gerarThumbnail(origem, destino).catch((err: unknown) => aoFalhar?.(err));
}

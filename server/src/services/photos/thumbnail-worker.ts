import { workerData } from 'node:worker_threads';

import { gerarThumbnail } from './thumbnails.js';

/** Corpo do worker de thumbnails — 1 worker por foto, morre ao terminar (unref no pai). */
const { origem, destino } = workerData as { origem: string; destino: string };

await gerarThumbnail(origem, destino);

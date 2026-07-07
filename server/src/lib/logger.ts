import path from 'node:path';

import pino from 'pino';

import type { Env } from './env.js';

/**
 * Logger do processo: arquivo com rotação diária (14 dias) em RHODES_DATA_DIR/logs,
 * com saída legível no terminal em desenvolvimento. Silencioso em teste.
 */
export function createLogger(env: Env): pino.Logger {
  if (env.NODE_ENV === 'test') {
    return pino({ level: 'silent' });
  }

  const targets: pino.TransportTargetOptions[] = [
    {
      target: 'pino-roll',
      options: {
        file: path.join(env.LOGS_DIR, 'app'),
        frequency: 'daily',
        extension: '.log',
        limit: { count: 14 },
        mkdir: true,
      },
    },
  ];

  if (env.NODE_ENV === 'development') {
    targets.push({ target: 'pino-pretty', options: {} });
  }

  return pino({ level: 'info' }, pino.transport({ targets }));
}

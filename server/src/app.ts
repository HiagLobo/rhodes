import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type DatabaseType from 'better-sqlite3';

import { healthRoutes } from './routes/health.js';

export type BuildAppOptions = {
  sqlite: DatabaseType.Database;
  logger?: Logger;
};

/** Fábrica do app — recebe dependências prontas para ser testável com banco temporário. */
export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify(
    // cast: o fastify embute tipos do pino 9; a instância do pino 10 é estruturalmente compatível
    opts.logger ? { loggerInstance: opts.logger as unknown as FastifyBaseLogger } : { logger: false },
  );

  app.register(healthRoutes, { sqlite: opts.sqlite });

  return app;
}

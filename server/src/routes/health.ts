import { createRequire } from 'node:module';

import type DatabaseType from 'better-sqlite3';
import type { FastifyPluginCallback } from 'fastify';

// server/package.json fica a 2 níveis tanto de src/routes quanto de dist/routes.
const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };

export type HealthOptions = { sqlite: DatabaseType.Database };

export const healthRoutes: FastifyPluginCallback<HealthOptions> = (app, opts, done) => {
  app.get('/api/health', (_req, reply) => {
    let dbOk = true;
    try {
      opts.sqlite.prepare('SELECT 1').get();
    } catch {
      dbOk = false;
    }

    // Nunca expor caminhos, nomes de arquivo ou detalhes internos aqui.
    return reply.status(dbOk ? 200 : 503).send({
      status: dbOk ? 'ok' : 'degradado',
      db: dbOk ? 'ok' : 'erro',
      version: pkg.version,
    });
  });

  done();
};

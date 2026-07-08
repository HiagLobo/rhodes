import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type DatabaseType from 'better-sqlite3';

import { healthRoutes } from './routes/health.js';

// web/dist fica a 2 níveis deste arquivo tanto em src/ quanto em dist/ (build da S4).
export const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

export type BuildAppOptions = {
  sqlite: DatabaseType.Database;
  logger?: Logger;
  /**
   * Raiz dos estáticos da SPA. Sem valor: serve web/dist quando NODE_ENV=production
   * e não serve nada em dev/teste (o Vite cuida do front em dev).
   */
  staticRoot?: string | null;
};

/** Fábrica do app — recebe dependências prontas para ser testável com banco temporário. */
export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify(
    // cast: o fastify embute tipos do pino 9; a instância do pino 10 é estruturalmente compatível
    opts.logger ? { loggerInstance: opts.logger as unknown as FastifyBaseLogger } : { logger: false },
  );

  app.register(healthRoutes, { sqlite: opts.sqlite });

  const staticRoot =
    opts.staticRoot !== undefined
      ? opts.staticRoot
      : process.env.NODE_ENV === 'production'
        ? WEB_DIST
        : null;

  if (staticRoot) {
    app.register(fastifyStatic, { root: staticRoot, wildcard: false });

    // Fallback SPA: rota desconhecida devolve o index.html — mas NUNCA para /api/*,
    // que precisa responder 404 JSON de verdade.
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api/')) {
        return reply.status(404).send({ erro: 'Rota não encontrada' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

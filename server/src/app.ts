import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { FOTO_MAX_BYTES } from '@rhodes/shared';
import type { Logger } from 'pino';
import type DatabaseType from 'better-sqlite3';

import type { Db } from './db/index.js';
import { authRoutes } from './routes/auth.js';
import { calendarioRoutes } from './routes/calendario.js';
import { catalogoRoutes } from './routes/catalogo.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { demeritosRoutes } from './routes/demeritos.js';
import { externalAuditRoutes } from './routes/external-audit.js';
import { fotosRoutes } from './routes/fotos.js';
import { healthRoutes } from './routes/health.js';
import { justificativasRoutes } from './routes/justificativas.js';
import { instanciasRoutes } from './routes/instancias.js';
import { naviosRoutes } from './routes/navios.js';
import { scoreRoutes } from './routes/score.js';
import { scoreConfigRoutes } from './routes/score-config.js';
import { usuariosRoutes } from './routes/usuarios.js';
import { vistoriaRoutes } from './routes/vistoria.js';

// web/dist fica a 2 níveis deste arquivo tanto em src/ quanto em dist/ (build da S4).
export const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

export type BuildAppOptions = {
  db: Db;
  sqlite: DatabaseType.Database;
  logger?: Logger;
  /**
   * Raiz dos estáticos da SPA. Sem valor: serve web/dist quando NODE_ENV=production
   * e não serve nada em dev/teste (o Vite cuida do front em dev).
   */
  staticRoot?: string | null;
  /**
   * Onde as fotos vivem (RHODES_DATA_DIR) — o index.ts SEMPRE passa; o default em tmp
   * existe só para os testes antigos que não tocam em foto.
   */
  dataDir?: string;
};

/** Fábrica do app — recebe dependências prontas para ser testável com banco temporário. */
export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify(
    // cast: o fastify embute tipos do pino 9; a instância do pino 10 é estruturalmente compatível
    opts.logger ? { loggerInstance: opts.logger as unknown as FastifyBaseLogger } : { logger: false },
  );

  app.register(fastifyCookie);
  // Limite ANTES de bufferizar: o multipart corta o stream no fileSize (não lê 1 GB para negar).
  app.register(fastifyMultipart, { limits: { fileSize: FOTO_MAX_BYTES, files: 1 } });
  app.register(healthRoutes, { sqlite: opts.sqlite });
  app.register(authRoutes, { db: opts.db });
  app.register(usuariosRoutes, { db: opts.db });
  app.register(catalogoRoutes, { db: opts.db });
  app.register(instanciasRoutes, { db: opts.db });
  app.register(naviosRoutes, { db: opts.db });
  app.register(vistoriaRoutes, { db: opts.db });
  app.register(dashboardRoutes, { db: opts.db });
  app.register(justificativasRoutes, { db: opts.db });
  app.register(calendarioRoutes, { db: opts.db });
  app.register(demeritosRoutes, { db: opts.db });
  app.register(scoreRoutes, { db: opts.db });
  app.register(scoreConfigRoutes, { db: opts.db });
  app.register(externalAuditRoutes, { db: opts.db });
  app.register(fotosRoutes, {
    db: opts.db,
    dataDir: opts.dataDir ?? path.join(os.tmpdir(), 'rhodes-fotos-dev'),
  });

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

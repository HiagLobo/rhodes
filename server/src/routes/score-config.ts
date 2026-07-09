import type { FastifyPluginCallback } from 'fastify';
import { scoreConfigInputSchema } from '@rhodes/shared';

import type { Db } from '../db/index.js';
import { scoreConfig } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { requireRole } from '../lib/auth.js';
import { lerScoreConfig } from '../services/score/config.js';

export const scoreConfigRoutes: FastifyPluginCallback<{ db: Db }> = (app, opts, done) => {
  const { db } = opts;
  const somenteGestor = requireRole(db, 'GESTOR');

  /** Config vigente (para o form da UI). Leitura para GESTOR. */
  app.get('/api/score-config', { preHandler: somenteGestor }, (_req, reply) => {
    return reply.send(lerScoreConfig(db));
  });

  /**
   * Calibra o score — INSERE uma nova linha (score_config é append-only; UPDATE aborta).
   * Ordem que funciona (achado da revisão): (1) parse do body SEM vistoriaAmostralPct;
   * (2) mescla vistoriaAmostralPct da linha VIGENTE (senão a amostragem da Onda 06 regride);
   * (3) INSERT. A engine passa a ler a última linha → o cálculo muda a partir de agora.
   */
  app.post('/api/score-config', { preHandler: somenteGestor }, (req, reply) => {
    const body = scoreConfigInputSchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ erro: body.error.issues[0]?.message ?? 'Dados inválidos.' });
    }

    const vigente = lerScoreConfig(db);
    const valores = { ...body.data, vistoriaAmostralPct: vigente.vistoriaAmostralPct };

    const criada = db
      .insert(scoreConfig)
      .values({ valores: JSON.stringify(valores), motivo: 'pesos ajustados pelo gestor', criadoPorId: req.user!.id })
      .returning()
      .get();
    audit(db, {
      ator: { id: req.user!.id, login: req.user!.login },
      acao: 'SCORE_CONFIG_ALTERADO',
      entidade: 'score_config',
      entidadeId: criada.id,
      antes: { pesos: vigente.pesos, demerito: vigente.demerito, tetoDemeritos: vigente.tetoDemeritos },
      depois: { pesos: valores.pesos, demerito: valores.demerito, tetoDemeritos: valores.tetoDemeritos },
      ip: req.ip,
    });
    return reply.status(201).send(valores);
  });

  done();
};

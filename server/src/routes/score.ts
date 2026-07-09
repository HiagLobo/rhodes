import type { FastifyPluginCallback } from 'fastify';
import { type ScoreResultado } from '@rhodes/shared';
import { z } from 'zod';

import type { Db } from '../db/index.js';
import { requireUser } from '../lib/auth.js';
import { coletarEventos } from '../services/score/coletar.js';
import { lerScoreConfig } from '../services/score/config.js';
import { calcularScore } from '../services/score/engine.js';

const JANELAS = [7, 30, 90] as const;
const janelaQuerySchema = z.object({
  janela: z.coerce.number().refine((v): v is (typeof JANELAS)[number] => (JANELAS as readonly number[]).includes(v), 'Janela deve ser 7, 30 ou 90').default(30),
});

/** Score recomputado on-read (sem cache — evento é a verdade; barato: ~39 tarefas/janela). */
export function calcularScoreDaJanela(db: Db, janelaDias: number, agora: Date): ScoreResultado {
  return calcularScore(coletarEventos(db, janelaDias, agora), lerScoreConfig(db));
}

export const scoreRoutes: FastifyPluginCallback<{ db: Db }> = (app, opts, done) => {
  const { db } = opts;
  const logado = requireUser(db);

  // Score é LEITURA para todos (a edição de pesos é outra rota, S5).
  app.get('/api/score', { preHandler: logado }, (req, reply) => {
    const q = janelaQuerySchema.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ erro: 'Janela inválida (7, 30 ou 90).' });
    return reply.send(calcularScoreDaJanela(db, q.data.janela, new Date()));
  });

  done();
};

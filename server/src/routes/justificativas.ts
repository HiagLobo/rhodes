import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginCallback } from 'fastify';
import {
  CLASSIFICACAO_POR_MOTIVO,
  decidirJustificativaSchema,
  JUSTIFICATIVA_STATUS,
  MOTIVOS_JUSTIFICATIVA,
  type Classificacao,
  type JustificativaFilaItem,
  type JustificativaResumo,
  type MotivoJustificativa,
  type ParetoMotivo,
} from '@rhodes/shared';
import { z } from 'zod';

import type { Db } from '../db/index.js';
import { areas, justificativas, taskInstances, taskTemplates, users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { requireRole } from '../lib/auth.js';

type JustificativaRow = typeof justificativas.$inferSelect;

/** Mapeia a linha para o resumo público (compartilhado com o GET detalhe da instância). */
export function justificativaResumo(
  j: JustificativaRow,
  criadoPor: string | null,
  decididoPor: string | null,
): JustificativaResumo {
  return {
    id: j.id,
    instanceId: j.instanceId,
    motivo: j.motivo as MotivoJustificativa,
    texto: j.texto,
    fotoId: j.fotoId,
    status: j.status as JustificativaResumo['status'],
    criadoPor,
    criadoEm: j.criadoEm.toISOString(),
    classificacao: j.classificacao as Classificacao | null,
    decididoPor,
    decididoEm: j.decididoEm?.toISOString() ?? null,
    decisaoObs: j.decisaoObs,
  };
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const filaQuerySchema = z.object({ status: z.enum(JUSTIFICATIVA_STATUS).default('PENDENTE') });
const paretoQuerySchema = z.object({ dias: z.coerce.number().int().min(1).max(365).default(30) });

export const justificativasRoutes: FastifyPluginCallback<{ db: Db }> = (app, opts, done) => {
  const { db } = opts;
  const somenteGestor = requireRole(db, 'GESTOR');

  /** Fila de aprovação — PENDENTE por antiguidade, com o contexto da tarefa. */
  app.get('/api/justificativas', { preHandler: somenteGestor }, (req, reply) => {
    const q = filaQuerySchema.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ erro: 'Dados inválidos.' });

    const rows = db
      .select({
        j: justificativas,
        criadoPor: users.login,
        areaNome: areas.nome,
        atividade: taskTemplates.atividade,
        dueDate: taskInstances.dueDate,
      })
      .from(justificativas)
      .innerJoin(users, eq(justificativas.criadoPorId, users.id))
      .innerJoin(taskInstances, eq(justificativas.instanceId, taskInstances.id))
      .innerJoin(taskTemplates, eq(taskInstances.templateId, taskTemplates.id))
      .innerJoin(areas, eq(taskTemplates.areaId, areas.id))
      .where(eq(justificativas.status, q.data.status))
      .orderBy(asc(justificativas.id))
      .all();

    const itens: JustificativaFilaItem[] = rows.map((r) => ({
      ...justificativaResumo(r.j, r.criadoPor, null),
      areaNome: r.areaNome,
      atividade: r.atividade,
      dueDate: r.dueDate,
    }));
    return reply.send(itens);
  });

  /** Pareto por motivo — só CONTAGEM (o efeito no score é da Onda 08). */
  app.get('/api/justificativas/pareto', { preHandler: somenteGestor }, (req, reply) => {
    const q = paretoQuerySchema.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ erro: 'Dados inválidos.' });
    const desde = Math.floor(Date.now() / 1000) - q.data.dias * 86_400;

    const rows = db
      .select({ motivo: justificativas.motivo, n: sql<number>`count(*)` })
      .from(justificativas)
      .where(sql`${justificativas.criadoEm} >= ${desde}`)
      .groupBy(justificativas.motivo)
      .all();
    const total = rows.reduce((s, r) => s + r.n, 0);
    const porMotivo = new Map(rows.map((r) => [r.motivo, r.n]));

    // ordena por contagem desc, mantendo todos os motivos (Pareto — barras zeradas incluídas)
    const pareto: ParetoMotivo[] = MOTIVOS_JUSTIFICATIVA.map((motivo) => {
      const n = porMotivo.get(motivo) ?? 0;
      return { motivo, total: n, pct: total > 0 ? Math.round((n / total) * 100) : 0 };
    }).sort((a, b) => b.total - a.total);
    return reply.send({ total, pareto });
  });

  /**
   * Decisão do gestor. UPDATE apenas de status/classificacao/decidido_* — motivo/texto/foto
   * são IMUTÁVEIS (ALCOA+); e NÃO altera nenhuma data (o reagendamento já aconteceu no
   * onJustify no ato de justificar — mexer aqui estouraria o índice único de 1 aberta).
   */
  app.patch('/api/justificativas/:id/decisao', { preHandler: somenteGestor }, (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    const body = decidirJustificativaSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ erro: 'Dados inválidos.' });
    }

    const j = db.select().from(justificativas).where(eq(justificativas.id, params.data.id)).get();
    if (!j) return reply.status(404).send({ erro: 'Justificativa não encontrada.' });
    if (j.status !== 'PENDENTE') {
      return reply.status(409).send({ erro: 'Esta justificativa já foi decidida.' });
    }

    const motivo = j.motivo as MotivoJustificativa;
    // classificacao só faz sentido em OUTRO aprovada; mandá-la fora disso é erro explícito.
    if (body.data.classificacao !== undefined && !(motivo === 'OUTRO' && body.data.decisao === 'APROVADA')) {
      return reply
        .status(400)
        .send({ erro: 'Classificação só se aplica a uma justificativa OUTRO aprovada.' });
    }

    let classificacao: Classificacao | null = null;
    if (body.data.decisao === 'APROVADA') {
      if (motivo === 'OUTRO') {
        if (body.data.classificacao === undefined) {
          return reply
            .status(400)
            .send({ erro: 'Aprovar um motivo OUTRO exige classificar como EXTERNA ou INTERNA.' });
        }
        classificacao = body.data.classificacao;
      } else {
        classificacao = CLASSIFICACAO_POR_MOTIVO[motivo]; // nunca null para os 6 códigos fixos
      }
    }
    // REPROVADA: classificacao fica NULL (não entra no denominador de nada — Onda 08).

    const agora = new Date();
    const ator = { id: req.user!.id, login: req.user!.login };
    const atualizada = db
      .update(justificativas)
      .set({
        status: body.data.decisao,
        classificacao,
        decididoPorId: ator.id,
        decididoEm: agora,
        decisaoObs: body.data.obs ?? null,
      })
      .where(eq(justificativas.id, j.id))
      .returning()
      .get()!;

    audit(db, {
      ator,
      acao: body.data.decisao === 'APROVADA' ? 'JUSTIFICATIVA_APROVADA' : 'JUSTIFICATIVA_REPROVADA',
      entidade: 'justificativas',
      entidadeId: j.id,
      antes: { status: 'PENDENTE' },
      depois: { status: body.data.decisao, classificacao, instanceId: j.instanceId },
      ip: req.ip,
    });

    return reply.send(justificativaResumo(atualizada, null, ator.login));
  });

  done();
};

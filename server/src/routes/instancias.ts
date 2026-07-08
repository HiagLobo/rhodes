import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginCallback } from 'fastify';
import {
  overrideDueSchema,
  somarDias,
  STATUS_ABERTOS,
  type InstanciaResumo,
} from '@rhodes/shared';
import { z } from 'zod';

import type { Db } from '../db/index.js';
import { areas, taskInstances, taskTemplates, users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { requireRole, requireUser } from '../lib/auth.js';
import { ConclusaoInvalidaError, onComplete } from '../services/scheduler/on-complete.js';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export const instanciasRoutes: FastifyPluginCallback<{ db: Db }> = (app, opts, done) => {
  const { db } = opts;
  const logado = requireUser(db);
  const executa = requireRole(db, 'EXECUTANTE', 'GESTOR');
  const somenteGestor = requireRole(db, 'GESTOR');

  /**
   * Lista AGORA — SELECT puro sobre instâncias materializadas (imutável 4: zero cálculo
   * de recorrência na leitura). Ordenação no SQL: atrasadas primeiro, depois janela.
   */
  app.get('/api/agora', { preHandler: logado }, (): InstanciaResumo[] => {
    const rows = db
      .select({
        inst: taskInstances,
        areaId: areas.id,
        areaNome: areas.nome,
        atividade: taskTemplates.atividade,
        frequency: taskTemplates.frequency,
        triggerType: taskTemplates.triggerType,
        executanteLogin: users.login,
      })
      .from(taskInstances)
      .innerJoin(taskTemplates, eq(taskInstances.templateId, taskTemplates.id))
      .innerJoin(areas, eq(taskTemplates.areaId, areas.id))
      .leftJoin(users, eq(taskInstances.executanteId, users.id))
      .where(inArray(taskInstances.status, [...STATUS_ABERTOS]))
      .orderBy(
        sql`CASE ${taskInstances.status} WHEN 'OVERDUE' THEN 0 ELSE 1 END`,
        asc(taskInstances.windowEnd),
        asc(areas.nome),
      )
      .all();

    return rows.map((r) => ({
      id: r.inst.id,
      templateId: r.inst.templateId,
      areaId: r.areaId,
      areaNome: r.areaNome,
      atividade: r.atividade,
      frequency: r.frequency as InstanciaResumo['frequency'],
      triggerType: r.triggerType as InstanciaResumo['triggerType'],
      dueDate: r.inst.dueDate,
      windowEnd: r.inst.windowEnd,
      status: r.inst.status as InstanciaResumo['status'],
      origin: r.inst.origin as InstanciaResumo['origin'],
      executanteLogin: r.executanteLogin,
    }));
  });

  app.post('/api/instancias/:id/iniciar', { preHandler: executa }, (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ erro: 'Dados inválidos.' });

    const inst = db.select().from(taskInstances).where(eq(taskInstances.id, params.data.id)).get();
    if (!inst) return reply.status(404).send({ erro: 'Tarefa não encontrada.' });
    if (inst.status === 'IN_PROGRESS') {
      const quem = inst.executanteId
        ? db.select({ login: users.login }).from(users).where(eq(users.id, inst.executanteId)).get()
        : null;
      return reply
        .status(409)
        .send({ erro: `Tarefa já em execução${quem ? ` por ${quem.login}` : ''}.` });
    }
    if (inst.status !== 'PENDING' && inst.status !== 'OVERDUE') {
      return reply.status(409).send({ erro: 'Tarefa já fechada.' });
    }

    const atualizada = db
      .update(taskInstances)
      .set({ status: 'IN_PROGRESS', executanteId: req.user!.id, startedAt: new Date() })
      .where(eq(taskInstances.id, inst.id))
      .returning()
      .get()!;
    audit(db, {
      ator: { id: req.user!.id, login: req.user!.login },
      acao: 'INSTANCIA_INICIADA',
      entidade: 'task_instances',
      entidadeId: inst.id,
      antes: { status: inst.status },
      depois: { status: 'IN_PROGRESS' },
      ip: req.ip,
    });
    return reply.send(atualizada);
  });

  // PROVISÓRIA (Onda 03): a Onda 05 passa a EXIGIR foto ANTES+DEPOIS válidas neste endpoint
  // antes de chamar o onComplete (imutável 3 — conclusão validada no backend).
  app.post('/api/instancias/:id/concluir', { preHandler: executa }, (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ erro: 'Dados inválidos.' });
    try {
      const r = onComplete(
        db,
        params.data.id,
        { id: req.user!.id, login: req.user!.login },
        new Date(),
        req.ip,
      );
      return reply.send({
        statusFinal: r.statusFinal,
        proximaDue: r.proxima?.dueDate ?? null,
      });
    } catch (err) {
      if (err instanceof ConclusaoInvalidaError) {
        return reply.status(409).send({ erro: err.message });
      }
      throw err;
    }
  });

  app.patch('/api/instancias/:id/due-date', { preHandler: somenteGestor }, (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    const body = overrideDueSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ erro: 'Dados inválidos.' });
    }

    const inst = db.select().from(taskInstances).where(eq(taskInstances.id, params.data.id)).get();
    if (!inst) return reply.status(404).send({ erro: 'Tarefa não encontrada.' });
    if (!(STATUS_ABERTOS as readonly string[]).includes(inst.status)) {
      return reply.status(409).send({ erro: 'Tarefa já fechada — não dá para remarcar.' });
    }

    const template = db
      .select()
      .from(taskTemplates)
      .where(eq(taskTemplates.id, inst.templateId))
      .get()!;
    const windowEnd = somarDias(body.data.dueDate, template.graceDays);
    const atualizada = db
      .update(taskInstances)
      .set({ dueDate: body.data.dueDate, windowEnd })
      .where(eq(taskInstances.id, inst.id))
      .returning()
      .get()!;

    // Requisito "gestor define datas" — sempre com trilha antes/depois (imutável 2).
    audit(db, {
      ator: { id: req.user!.id, login: req.user!.login },
      acao: 'INSTANCIA_DUE_ALTERADA',
      entidade: 'task_instances',
      entidadeId: inst.id,
      antes: { dueDate: inst.dueDate, windowEnd: inst.windowEnd },
      depois: { dueDate: atualizada.dueDate, windowEnd: atualizada.windowEnd },
      ip: req.ip,
    });
    return reply.send(atualizada);
  });

  done();
};

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyPluginCallback } from 'fastify';
import {
  SEVERIDADES_DEMERITO,
  type DemeritoConfirmado,
  type DemeritoPendente,
  type Severidade,
} from '@rhodes/shared';
import { z } from 'zod';

import type { Db } from '../db/index.js';
import { areas, demeritos, inspections, taskInstances, taskTemplates, users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { requireRole } from '../lib/auth.js';

const confirmarSchema = z.object({ inspectionId: z.number().int().positive() });

export const demeritosRoutes: FastifyPluginCallback<{ db: Db }> = (app, opts, done) => {
  const { db } = opts;
  const somenteGestor = requireRole(db, 'GESTOR');

  /**
   * Fila de confirmação: reprovações de severidade CRITICA/MAIOR SEM demérito confirmado ainda
   * (anti-join com `demeritos`). MENOR nunca aparece (não gera demérito — decisão da onda).
   */
  app.get('/api/demeritos/pendentes', { preHandler: somenteGestor }, (_req, reply) => {
    const rows = db
      .select({
        inspectionId: inspections.id,
        instanceId: inspections.instanceId,
        severidade: inspections.severidade,
        criadoEm: inspections.criadoEm,
        vistoriador: users.login,
        areaId: areas.id,
        areaNome: areas.nome,
        atividade: taskTemplates.atividade,
      })
      .from(inspections)
      .innerJoin(taskInstances, eq(inspections.instanceId, taskInstances.id))
      .innerJoin(taskTemplates, eq(taskInstances.templateId, taskTemplates.id))
      .innerJoin(areas, eq(taskTemplates.areaId, areas.id))
      .leftJoin(users, eq(inspections.vistoriadorId, users.id))
      .leftJoin(demeritos, eq(demeritos.inspectionId, inspections.id))
      .where(
        and(
          eq(inspections.resultado, 'REPROVADA'),
          inArray(inspections.severidade, [...SEVERIDADES_DEMERITO]),
          isNull(demeritos.id),
        ),
      )
      .orderBy(asc(inspections.id))
      .all();

    const itens: DemeritoPendente[] = rows.map((r) => ({
      inspectionId: r.inspectionId,
      instanceId: r.instanceId,
      areaId: r.areaId,
      areaNome: r.areaNome,
      atividade: r.atividade,
      severidade: r.severidade as Severidade,
      vistoriador: r.vistoriador,
      criadoEm: r.criadoEm.toISOString(),
    }));
    return reply.send(itens);
  });

  /**
   * CONFIRMA o demérito (2º gate da dupla confirmação). Exige: inspeção REPROVADA de severidade
   * CRITICA/MAIOR; gestor ≠ vistoriador que reprovou (segregação — a dupla confirmação precisa
   * de DUAS pessoas). O valor (−8/−3) e o teto vêm do score_config na engine, não daqui.
   */
  app.post('/api/demeritos', { preHandler: somenteGestor }, (req, reply) => {
    const body = confirmarSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ erro: 'Dados inválidos.' });

    const insp = db.select().from(inspections).where(eq(inspections.id, body.data.inspectionId)).get();
    if (!insp) return reply.status(404).send({ erro: 'Inspeção não encontrada.' });
    if (insp.resultado !== 'REPROVADA' || !(SEVERIDADES_DEMERITO as readonly string[]).includes(insp.severidade ?? '')) {
      return reply.status(400).send({ erro: 'Só reprovações CRÍTICA/MAIOR geram demérito.' });
    }
    if (insp.vistoriadorId === req.user!.id) {
      return reply
        .status(403)
        .send({ erro: 'Quem reprovou não confirma o próprio demérito — precisa de outra pessoa.' });
    }
    if (db.select({ id: demeritos.id }).from(demeritos).where(eq(demeritos.inspectionId, insp.id)).get()) {
      return reply.status(409).send({ erro: 'Demérito já confirmado para esta reprovação.' });
    }

    // a área do demérito é a da instância reprovada
    const areaRow = db
      .select({ areaId: taskTemplates.areaId })
      .from(taskInstances)
      .innerJoin(taskTemplates, eq(taskInstances.templateId, taskTemplates.id))
      .where(eq(taskInstances.id, insp.instanceId))
      .get()!;

    const criado = db
      .insert(demeritos)
      .values({
        inspectionId: insp.id,
        areaId: areaRow.areaId,
        severidade: insp.severidade!,
        confirmadoPorId: req.user!.id,
      })
      .returning()
      .get();
    audit(db, {
      ator: { id: req.user!.id, login: req.user!.login },
      acao: 'DEMERITO_CONFIRMADO',
      entidade: 'demeritos',
      entidadeId: criado.id,
      depois: { inspectionId: insp.id, severidade: insp.severidade, areaId: areaRow.areaId },
      ip: req.ip,
    });
    return reply.status(201).send({ id: criado.id, inspectionId: insp.id, severidade: insp.severidade });
  });

  /** Extrato dos deméritos confirmados. */
  app.get('/api/demeritos', { preHandler: somenteGestor }, (_req, reply) => {
    const rows = db
      .select({
        id: demeritos.id,
        inspectionId: demeritos.inspectionId,
        severidade: demeritos.severidade,
        criadoEm: demeritos.criadoEm,
        areaNome: areas.nome,
        confirmadoPor: users.login,
      })
      .from(demeritos)
      .innerJoin(areas, eq(demeritos.areaId, areas.id))
      .leftJoin(users, eq(demeritos.confirmadoPorId, users.id))
      .orderBy(asc(demeritos.id))
      .all();
    const itens: DemeritoConfirmado[] = rows.map((r) => ({
      id: r.id,
      inspectionId: r.inspectionId,
      areaNome: r.areaNome,
      severidade: r.severidade as Severidade,
      confirmadoPor: r.confirmadoPor,
      criadoEm: r.criadoEm.toISOString(),
    }));
    return reply.send(itens);
  });

  done();
};

import { asc, desc, eq, ne } from 'drizzle-orm';
import type { FastifyPluginCallback } from 'fastify';
import {
  criarNavioSchema,
  editarEtaSchema,
  transicaoValida,
  transicaoNavioSchema,
  type EventoNavio,
  type NavioStatus,
  type OperacaoNavio,
  type RodadaResumo,
} from '@rhodes/shared';
import { z } from 'zod';

import type { Db } from '../db/index.js';
import { areas, shipEvents, shipOperations, taskInstances, taskTemplates, users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { requireRole, requireUser } from '../lib/auth.js';
import { onShipEvent, reagendarPreArrival } from '../services/scheduler/on-ship-event.js';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export const naviosRoutes: FastifyPluginCallback<{ db: Db }> = (app, opts, done) => {
  const { db } = opts;
  const logado = requireUser(db);
  const registra = requireRole(db, 'GESTOR', 'EXECUTANTE'); // supervisor de turno registra
  const somenteGestor = requireRole(db, 'GESTOR');

  function eventosDe(operationId: number): EventoNavio[] {
    return db
      .select({ ev: shipEvents, login: users.login })
      .from(shipEvents)
      .innerJoin(users, eq(shipEvents.registradoPorId, users.id))
      .where(eq(shipEvents.operationId, operationId))
      .orderBy(asc(shipEvents.id))
      .all()
      .map((r) => ({
        id: r.ev.id,
        transicao: r.ev.transicao as NavioStatus,
        eventAt: r.ev.eventAt.toISOString(),
        registeredAt: r.ev.registeredAt.toISOString(),
        registradoPor: r.login,
        confirmado: r.ev.confirmadoPorId !== null,
      }));
  }

  function toOperacao(op: typeof shipOperations.$inferSelect): OperacaoNavio {
    return {
      id: op.id,
      navio: op.navio,
      produto: op.produto,
      tonelagem: op.tonelagem,
      etaDate: op.etaDate,
      status: op.status as NavioStatus,
      eventos: eventosDe(op.id),
    };
  }

  app.get('/api/navios', { preHandler: logado }, (req) => {
    const q = req.query as { ativas?: string };
    const rows = db
      .select()
      .from(shipOperations)
      .where(q.ativas ? ne(shipOperations.status, 'DESATRACADO') : undefined)
      .orderBy(desc(shipOperations.id))
      .all();
    return rows.map(toOperacao);
  });

  app.get('/api/navios/:id/rodada', { preHandler: logado }, (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ erro: 'Dados inválidos.' });
    const itens = db
      .select({
        id: taskInstances.id,
        status: taskInstances.status,
        dueDate: taskInstances.dueDate,
        atividade: taskTemplates.atividade,
        areaNome: areas.nome,
      })
      .from(taskInstances)
      .innerJoin(taskTemplates, eq(taskInstances.templateId, taskTemplates.id))
      .innerJoin(areas, eq(taskTemplates.areaId, areas.id))
      .where(eq(taskInstances.roundId, params.data.id))
      .orderBy(asc(areas.nome))
      .all();
    const resumo: RodadaResumo = {
      total: itens.length,
      concluidas: itens.filter((i) => i.status.startsWith('DONE')).length,
    };
    return reply.send({ resumo, itens });
  });

  app.post('/api/navios', { preHandler: registra }, (req, reply) => {
    const parsed = criarNavioSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ erro: 'Dados inválidos.' });
    const agora = new Date();
    const ator = { id: req.user!.id, login: req.user!.login };
    const ehGestor = req.user!.role === 'GESTOR';

    const op = db
      .insert(shipOperations)
      .values({
        navio: parsed.data.navio,
        produto: parsed.data.produto ?? null,
        tonelagem: parsed.data.tonelagem ?? null,
        etaDate: parsed.data.etaDate,
        criadoPorId: ator.id,
      })
      .returning()
      .get();
    db.insert(shipEvents)
      .values({
        operationId: op.id,
        transicao: 'ANUNCIADO',
        eventAt: agora, // o anúncio É o registro
        registradoPorId: ator.id,
        confirmadoPorId: ehGestor ? ator.id : null,
      })
      .run();

    const disparo = onShipEvent(db, op.id, 'ANUNCIADO', agora, ator, req.ip);
    audit(db, {
      ator,
      acao: 'NAVIO_ANUNCIADO',
      entidade: 'ship_operations',
      entidadeId: op.id,
      depois: { navio: op.navio, etaDate: op.etaDate, preArrival: disparo.criadas.length },
      ip: req.ip,
    });
    return reply.status(201).send(toOperacao(op));
  });

  app.post('/api/navios/:id/transicao', { preHandler: registra }, (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    const body = transicaoNavioSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ erro: 'Dados inválidos.' });
    }
    const op = db.select().from(shipOperations).where(eq(shipOperations.id, params.data.id)).get();
    if (!op) return reply.status(404).send({ erro: 'Operação não encontrada.' });
    if (!transicaoValida(op.status as NavioStatus, body.data.para)) {
      return reply
        .status(409)
        .send({ erro: `Transição inválida: ${op.status} → ${body.data.para}.` });
    }

    const agora = new Date();
    const eventAt = new Date(body.data.eventAt);
    if (eventAt.getTime() > agora.getTime()) {
      return reply.status(400).send({ erro: 'A hora do evento não pode estar no futuro.' });
    }
    const ultimo = db
      .select()
      .from(shipEvents)
      .where(eq(shipEvents.operationId, op.id))
      .orderBy(desc(shipEvents.id))
      .get();
    if (ultimo && eventAt.getTime() < ultimo.eventAt.getTime()) {
      return reply
        .status(400)
        .send({ erro: 'A hora do evento não pode ser anterior ao evento anterior.' });
    }

    const ator = { id: req.user!.id, login: req.user!.login };
    const ehGestor = req.user!.role === 'GESTOR';
    db.insert(shipEvents)
      .values({
        operationId: op.id,
        transicao: body.data.para,
        eventAt,
        registradoPorId: ator.id,
        confirmadoPorId: ehGestor ? ator.id : null,
      })
      .run();
    const atualizada = db
      .update(shipOperations)
      .set({ status: body.data.para })
      .where(eq(shipOperations.id, op.id))
      .returning()
      .get()!;

    const disparo = onShipEvent(db, op.id, body.data.para, eventAt, ator, req.ip);
    audit(db, {
      ator,
      acao: 'NAVIO_TRANSICAO',
      entidade: 'ship_operations',
      entidadeId: op.id,
      antes: { status: op.status },
      depois: {
        status: body.data.para,
        eventAt: eventAt.toISOString(),
        rodada: disparo.criadas.length + disparo.antecipadas.length,
      },
      ip: req.ip,
    });
    return reply.send(toOperacao(atualizada));
  });

  app.patch('/api/navios/:id/eta', { preHandler: somenteGestor }, (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    const body = editarEtaSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ erro: 'Dados inválidos.' });
    }
    const op = db.select().from(shipOperations).where(eq(shipOperations.id, params.data.id)).get();
    if (!op) return reply.status(404).send({ erro: 'Operação não encontrada.' });
    if (op.status !== 'ANUNCIADO') {
      return reply.status(409).send({ erro: 'ETA só pode ser remarcado antes da atracação.' });
    }

    const ator = { id: req.user!.id, login: req.user!.login };
    const atualizada = db
      .update(shipOperations)
      .set({ etaDate: body.data.etaDate })
      .where(eq(shipOperations.id, op.id))
      .returning()
      .get()!;
    const reagendadas = reagendarPreArrival(db, op.id, body.data.etaDate, ator, req.ip);
    audit(db, {
      ator,
      acao: 'NAVIO_ETA_ALTERADA',
      entidade: 'ship_operations',
      entidadeId: op.id,
      antes: { etaDate: op.etaDate },
      depois: { etaDate: body.data.etaDate, reagendadas: reagendadas.length },
      ip: req.ip,
    });
    return reply.send(toOperacao(atualizada));
  });

  app.post('/api/navios/eventos/:id/confirmar', { preHandler: somenteGestor }, (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ erro: 'Dados inválidos.' });
    const ev = db.select().from(shipEvents).where(eq(shipEvents.id, params.data.id)).get();
    if (!ev) return reply.status(404).send({ erro: 'Evento não encontrado.' });
    if (ev.confirmadoPorId !== null) {
      return reply.status(409).send({ erro: 'Evento já confirmado.' });
    }
    db.update(shipEvents)
      .set({ confirmadoPorId: req.user!.id })
      .where(eq(shipEvents.id, ev.id))
      .run();
    audit(db, {
      ator: { id: req.user!.id, login: req.user!.login },
      acao: 'NAVIO_EVENTO_CONFIRMADO',
      entidade: 'ship_events',
      entidadeId: ev.id,
      depois: { transicao: ev.transicao },
      ip: req.ip,
    });
    return reply.send({ ok: true });
  });

  done();
};

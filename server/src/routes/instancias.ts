import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginCallback } from 'fastify';
import {
  justificarSchema,
  overrideDueSchema,
  registrarParteSchema,
  somarDias,
  STATUS_ABERTOS,
  type FotoResumo,
  type InstanciaDetalhe,
  type InstanciaResumo,
  type JustificativaResumo,
  type ParteResumo,
} from '@rhodes/shared';
import { z } from 'zod';

import type { Db } from '../db/index.js';
import {
  areas,
  execucaoPartes,
  inspections,
  justificativas,
  metodoVersoes,
  photos,
  taskInstances,
  taskTemplates,
  users,
} from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { requireRole, requireUser } from '../lib/auth.js';
import {
  ConclusaoInvalidaError,
  onComplete,
  onJustify,
} from '../services/scheduler/on-complete.js';
import { paraInspecaoResumo } from './vistoria.js';
import {
  EvidenciaInvalidaError,
  parteCorrente,
  tempoPorPartes,
  validarEvidencia,
  type FotoEvidencia,
} from '../services/scheduler/validar-evidencia.js';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

/** Linha de `photos` → shape mínimo do validador de evidência. */
function paraEvidencia(f: { tipo: string; parte: number; receivedAt: string | Date }): FotoEvidencia {
  return {
    tipo: f.tipo,
    parte: f.parte,
    receivedAt: f.receivedAt instanceof Date ? f.receivedAt : new Date(f.receivedAt),
  };
}

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

  /** Fotos da instância no shape que o validador entende (received_at é a verdade). */
  function fotosDe(instanciaId: number) {
    return db.select().from(photos).where(eq(photos.instanceId, instanciaId)).all();
  }

  /**
   * Detalhe de uma tarefa — contrato da tela de execução (S4): método vigente, evidência,
   * partes e o tempo medido sozinho (received_at do servidor, nunca relógio do aparelho).
   */
  app.get('/api/instancias/:id', { preHandler: logado }, (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ erro: 'Dados inválidos.' });

    const row = db
      .select({
        inst: taskInstances,
        areaId: areas.id,
        areaNome: areas.nome,
        template: taskTemplates,
        executanteLogin: users.login,
      })
      .from(taskInstances)
      .innerJoin(taskTemplates, eq(taskInstances.templateId, taskTemplates.id))
      .innerJoin(areas, eq(taskTemplates.areaId, areas.id))
      .leftJoin(users, eq(taskInstances.executanteId, users.id))
      .where(eq(taskInstances.id, params.data.id))
      .get();
    if (!row) return reply.status(404).send({ erro: 'Tarefa não encontrada.' });

    const metodo = row.template.metodoVersaoAtualId
      ? (db
          .select({ texto: metodoVersoes.texto })
          .from(metodoVersoes)
          .where(eq(metodoVersoes.id, row.template.metodoVersaoAtualId))
          .get()?.texto ?? null)
      : null;

    const fotos: FotoResumo[] = db
      .select({ foto: photos, enviadoPor: users.login })
      .from(photos)
      .innerJoin(users, eq(photos.enviadoPorId, users.id))
      .where(eq(photos.instanceId, row.inst.id))
      .orderBy(asc(photos.id))
      .all()
      .map((r) => ({
        id: r.foto.id,
        instanceId: r.foto.instanceId,
        tipo: r.foto.tipo as FotoResumo['tipo'],
        parte: r.foto.parte,
        capturedAt: r.foto.capturedAt.toISOString(),
        receivedAt: r.foto.receivedAt.toISOString(),
        skewMs: r.foto.skewMs,
        exifDatetime: r.foto.exifDatetime,
        exifModel: r.foto.exifModel,
        tamanhoBytes: r.foto.tamanhoBytes,
        enviadoPor: r.enviadoPor,
      }));

    const partes: ParteResumo[] = db
      .select({ parte: execucaoPartes, executante: users.login })
      .from(execucaoPartes)
      .innerJoin(users, eq(execucaoPartes.executanteId, users.id))
      .where(eq(execucaoPartes.instanceId, row.inst.id))
      .orderBy(asc(execucaoPartes.parte))
      .all()
      .map((r) => ({
        parte: r.parte.parte,
        percentualAcumulado: r.parte.percentualAcumulado,
        observacao: r.parte.observacao,
        executante: r.executante,
        criadoEm: r.parte.criadoEm.toISOString(),
      }));

    const justificativa: JustificativaResumo | null = (() => {
      const r = db
        .select({ j: justificativas, criadoPor: users.login })
        .from(justificativas)
        .innerJoin(users, eq(justificativas.criadoPorId, users.id))
        .where(eq(justificativas.instanceId, row.inst.id))
        .get();
      if (!r) return null;
      return {
        id: r.j.id,
        instanceId: r.j.instanceId,
        motivo: r.j.motivo as JustificativaResumo['motivo'],
        texto: r.j.texto,
        fotoId: r.j.fotoId,
        status: r.j.status as JustificativaResumo['status'],
        criadoPor: r.criadoPor,
        criadoEm: r.j.criadoEm.toISOString(),
      };
    })();

    const detalhe: InstanciaDetalhe = {
      id: row.inst.id,
      templateId: row.inst.templateId,
      areaId: row.areaId,
      areaNome: row.areaNome,
      atividade: row.template.atividade,
      frequency: row.template.frequency as InstanciaDetalhe['frequency'],
      triggerType: row.template.triggerType as InstanciaDetalhe['triggerType'],
      dueDate: row.inst.dueDate,
      windowEnd: row.inst.windowEnd,
      status: row.inst.status as InstanciaDetalhe['status'],
      origin: row.inst.origin as InstanciaDetalhe['origin'],
      executanteLogin: row.executanteLogin,
      limitacoes: row.template.limitacoes,
      metodo,
      minFotosIntervaloMin: row.template.minFotosIntervaloMin,
      startedAt: row.inst.startedAt?.toISOString() ?? null,
      finishedAt: row.inst.finishedAt?.toISOString() ?? null,
      fotos,
      partes,
      parteCorrente: parteCorrente(db, row.inst.id),
      tempoExecucaoSeg: tempoPorPartes(fotos.map(paraEvidencia)),
      justificativa,
      inspecao: (() => {
        const r = db
          .select({ insp: inspections, vistoriador: users.login, retrabalhoDue: taskInstances.dueDate })
          .from(inspections)
          .innerJoin(users, eq(inspections.vistoriadorId, users.id))
          .leftJoin(taskInstances, eq(inspections.retrabalhoInstanceId, taskInstances.id))
          .where(eq(inspections.instanceId, row.inst.id))
          .get();
        return r ? paraInspecaoResumo(r.insp, r.vistoriador, r.retrabalhoDue) : null;
      })(),
    };
    return reply.send(detalhe);
  });

  /**
   * "Não foi possível realizar" — fecha como MISSED justificado e reagenda pelo motivo.
   * A foto de impedimento é opcional, mas se vier tem de ser IMPEDIMENTO DESTA instância.
   */
  app.post('/api/instancias/:id/justificar', { preHandler: executa }, (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    const body = justificarSchema.safeParse(req.body);
    if (!params.success) return reply.status(400).send({ erro: 'Dados inválidos.' });
    if (!body.success) {
      return reply
        .status(400)
        .send({ erro: body.error.issues[0]?.message ?? 'Dados inválidos.' });
    }

    if (body.data.fotoImpedimentoId !== undefined) {
      const foto = db
        .select()
        .from(photos)
        .where(eq(photos.id, body.data.fotoImpedimentoId))
        .get();
      if (!foto || foto.instanceId !== params.data.id || foto.tipo !== 'IMPEDIMENTO') {
        return reply.status(400).send({ erro: 'Foto de impedimento inválida para esta tarefa.' });
      }
    }

    try {
      const r = onJustify(
        db,
        params.data.id,
        {
          motivo: body.data.motivo,
          texto: body.data.texto ?? null,
          fotoId: body.data.fotoImpedimentoId ?? null,
        },
        { id: req.user!.id, login: req.user!.login },
        new Date(),
        req.ip,
      );
      return reply.send({
        statusFinal: 'MISSED',
        justificativaId: r.justificativaId,
        proximaDue: r.proxima?.dueDate ?? null,
      });
    } catch (err) {
      if (err instanceof ConclusaoInvalidaError) {
        return reply.status(409).send({ erro: err.message });
      }
      throw err;
    }
  });

  /** Fechamento parcial multi-dia — exige evidência completa DA PARTE (imutável 3). */
  app.post('/api/instancias/:id/partes', { preHandler: executa }, (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    const body = registrarParteSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ erro: 'Dados inválidos.' });
    }

    const inst = db.select().from(taskInstances).where(eq(taskInstances.id, params.data.id)).get();
    if (!inst) return reply.status(404).send({ erro: 'Tarefa não encontrada.' });
    if (inst.status !== 'IN_PROGRESS') {
      return reply.status(409).send({ erro: 'Inicie a tarefa antes de registrar uma parte.' });
    }
    if (inst.executanteId !== req.user!.id) {
      return reply.status(403).send({ erro: 'Só quem iniciou a tarefa registra partes.' });
    }

    const ultima = db
      .select({ pct: sql<number>`max(${execucaoPartes.percentualAcumulado})` })
      .from(execucaoPartes)
      .where(eq(execucaoPartes.instanceId, inst.id))
      .get();
    if (body.data.percentualAcumulado <= (ultima?.pct ?? 0)) {
      return reply.status(400).send({ erro: 'O percentual precisa avançar em relação à última parte.' });
    }

    const template = db
      .select()
      .from(taskTemplates)
      .where(eq(taskTemplates.id, inst.templateId))
      .get()!;
    const parte = parteCorrente(db, inst.id);
    let tempoSegParte: number;
    try {
      tempoSegParte = validarEvidencia(
        fotosDe(inst.id).map(paraEvidencia),
        parte,
        template.minFotosIntervaloMin,
      ).tempoSeg;
    } catch (err) {
      if (err instanceof EvidenciaInvalidaError) return reply.status(409).send({ erro: err.message });
      throw err;
    }

    const criada = db.transaction((tx) => {
      const t = tx as unknown as Db;
      const row = t
        .insert(execucaoPartes)
        .values({
          instanceId: inst.id,
          parte,
          percentualAcumulado: body.data.percentualAcumulado,
          observacao: body.data.observacao ?? null,
          executanteId: req.user!.id,
        })
        .returning()
        .get()!;
      audit(t, {
        ator: { id: req.user!.id, login: req.user!.login },
        acao: 'PARTE_REGISTRADA',
        entidade: 'task_instances',
        entidadeId: inst.id,
        depois: { parte, percentualAcumulado: body.data.percentualAcumulado, tempoSegParte },
        ip: req.ip,
      });
      return row;
    });

    return reply.status(201).send({
      parte: criada.parte,
      percentualAcumulado: criada.percentualAcumulado,
      tempoSegParte,
    });
  });

  // CONCLUSÃO REAL (Onda 05, substitui a provisória da 03): sem foto ANTES+DEPOIS válidas
  // da parte corrente o backend rejeita — a UI é casca (imutável 3). O motor segue intocado.
  app.post('/api/instancias/:id/concluir', { preHandler: executa }, (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ erro: 'Dados inválidos.' });

    const inst = db.select().from(taskInstances).where(eq(taskInstances.id, params.data.id)).get();
    if (!inst) return reply.status(404).send({ erro: 'Tarefa não encontrada.' });
    if (!(STATUS_ABERTOS as readonly string[]).includes(inst.status)) {
      return reply.status(409).send({ erro: 'Instância já fechada — nada para concluir.' });
    }

    const template = db
      .select()
      .from(taskTemplates)
      .where(eq(taskTemplates.id, inst.templateId))
      .get()!;
    const evidencias = fotosDe(inst.id).map(paraEvidencia);
    try {
      validarEvidencia(evidencias, parteCorrente(db, inst.id), template.minFotosIntervaloMin);
    } catch (err) {
      if (err instanceof EvidenciaInvalidaError) return reply.status(409).send({ erro: err.message });
      throw err;
    }

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
        tempoExecucaoSeg: tempoPorPartes(evidencias),
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

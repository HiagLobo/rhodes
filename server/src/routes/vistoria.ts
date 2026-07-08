import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { aprovarSchema, reprovarSchema, type InspecaoResumo } from '@rhodes/shared';
import { z } from 'zod';

import type { Db } from '../db/index.js';
import { areas, inspections, photos, taskInstances, taskTemplates, users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import {
  limparFalhasLogin,
  loginBloqueado,
  registrarFalhaLogin,
  requireRole,
} from '../lib/auth.js';
import { verificarSenha } from '../lib/passwords.js';
import {
  InspecaoInvalidaError,
  onInspect,
  SegregacaoError,
  type InspecaoRow,
} from '../services/scheduler/on-inspect.js';
import { tempoPorPartes } from '../services/scheduler/validar-evidencia.js';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

const filtroFilaSchema = z.object({
  areaId: z.coerce.number().int().positive().optional(),
  roundId: z.coerce.number().int().positive().optional(),
});

export function paraInspecaoResumo(
  row: InspecaoRow,
  vistoriador: string | null,
  retrabalhoDue: string | null,
): InspecaoResumo {
  return {
    id: row.id,
    instanceId: row.instanceId,
    resultado: row.resultado as InspecaoResumo['resultado'],
    motivo: row.motivo as InspecaoResumo['motivo'],
    severidade: row.severidade as InspecaoResumo['severidade'],
    texto: row.texto,
    amostral: row.amostral,
    vistoriador,
    criadoEm: row.criadoEm.toISOString(),
    retrabalhoInstanceId: row.retrabalhoInstanceId,
    retrabalhoDue,
  };
}

export const vistoriaRoutes: FastifyPluginCallback<{ db: Db }> = (app, opts, done) => {
  const { db } = opts;
  // GESTOR assume a fila na ausência do vistoriador (regra da onda) — sempre auditado.
  const vistoria = requireRole(db, 'VISTORIADOR', 'GESTOR');

  /**
   * Assinatura eletrônica: a senha do PRÓPRIO usuário verificada no ato (estilo
   * 21 CFR Part 11), com o mesmo rate-limit do login contra força bruta.
   * Devolve true quando a assinatura confere; senão já respondeu 401/429.
   */
  async function assinaturaConfere(
    req: FastifyRequest,
    reply: FastifyReply,
    senha: string,
  ): Promise<boolean> {
    const chave = `assinatura:${req.user!.id}`;
    if (loginBloqueado(chave)) {
      audit(db, {
        ator: { id: req.user!.id, login: req.user!.login },
        acao: 'ASSINATURA_RATE_LIMIT',
        ip: req.ip,
      });
      await reply
        .status(429)
        .send({ erro: 'Muitas tentativas de assinatura — aguarde 15 minutos.' });
      return false;
    }
    const u = db.select().from(users).where(eq(users.id, req.user!.id)).get()!;
    if (!(await verificarSenha(u.passwordHash, senha))) {
      registrarFalhaLogin(chave);
      await reply.status(401).send({ erro: 'Senha incorreta — a assinatura não confere.' });
      return false;
    }
    limparFalhasLogin(chave);
    return true;
  }

  /** Fila de vistoria: execuções concluídas SEM inspeção, mais antigas primeiro. */
  app.get('/api/vistoria/fila', { preHandler: vistoria }, (req, reply) => {
    const filtros = filtroFilaSchema.safeParse(req.query);
    if (!filtros.success) return reply.status(400).send({ erro: 'Dados inválidos.' });

    const conds: SQL[] = [
      inArray(taskInstances.status, ['DONE_ON_TIME', 'DONE_LATE']),
      isNull(inspections.id),
    ];
    if (filtros.data.areaId !== undefined) conds.push(eq(areas.id, filtros.data.areaId));
    if (filtros.data.roundId !== undefined) conds.push(eq(taskInstances.roundId, filtros.data.roundId));

    const rows = db
      .select({
        inst: taskInstances,
        areaId: areas.id,
        areaNome: areas.nome,
        atividade: taskTemplates.atividade,
        executanteLogin: users.login,
      })
      .from(taskInstances)
      .innerJoin(taskTemplates, eq(taskInstances.templateId, taskTemplates.id))
      .innerJoin(areas, eq(taskTemplates.areaId, areas.id))
      .leftJoin(users, eq(taskInstances.executanteId, users.id))
      .leftJoin(inspections, eq(inspections.instanceId, taskInstances.id))
      .where(and(...conds))
      .orderBy(asc(taskInstances.finishedAt))
      .all();

    // tempo de execução em lote (fila é curta — 1 query para todas as fotos)
    const ids = rows.map((r) => r.inst.id);
    const fotosTodas = ids.length
      ? db.select().from(photos).where(inArray(photos.instanceId, ids)).all()
      : [];

    return reply.send(
      rows.map((r) => ({
        id: r.inst.id,
        templateId: r.inst.templateId,
        areaId: r.areaId,
        areaNome: r.areaNome,
        atividade: r.atividade,
        executanteLogin: r.executanteLogin,
        status: r.inst.status,
        dueDate: r.inst.dueDate,
        finishedAt: r.inst.finishedAt?.toISOString() ?? null,
        roundId: r.inst.roundId,
        origin: r.inst.origin,
        reworkOfInstanceId: r.inst.reworkOfInstanceId,
        tempoExecucaoSeg: tempoPorPartes(
          fotosTodas
            .filter((f) => f.instanceId === r.inst.id)
            .map((f) => ({ tipo: f.tipo, parte: f.parte, receivedAt: f.receivedAt })),
        ),
        amostral: false, // S3 pluga o sorteio determinístico aqui
      })),
    );
  });

  app.post('/api/instancias/:id/aprovar', { preHandler: vistoria }, async (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    const body = aprovarSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ erro: 'Dados inválidos.' });
    }
    if (!(await assinaturaConfere(req, reply, body.data.senha))) return reply;

    try {
      const r = onInspect(
        db,
        params.data.id,
        { resultado: 'APROVADA' },
        { id: req.user!.id, login: req.user!.login },
        new Date(),
        req.ip,
      );
      return await reply.send(paraInspecaoResumo(r.inspecao, req.user!.login, null));
    } catch (err) {
      if (err instanceof SegregacaoError) return reply.status(403).send({ erro: err.message });
      if (err instanceof InspecaoInvalidaError) return reply.status(409).send({ erro: err.message });
      throw err;
    }
  });

  app.post('/api/instancias/:id/reprovar', { preHandler: vistoria }, async (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    const body = reprovarSchema.safeParse(req.body);
    if (!params.success) return reply.status(400).send({ erro: 'Dados inválidos.' });
    if (!body.success) {
      return reply
        .status(400)
        .send({ erro: body.error.issues[0]?.message ?? 'Dados inválidos.' });
    }

    if (body.data.fotoId !== undefined) {
      const foto = db.select().from(photos).where(eq(photos.id, body.data.fotoId)).get();
      if (!foto || foto.instanceId !== params.data.id) {
        return reply.status(400).send({ erro: 'Foto inválida para esta execução.' });
      }
    }
    if (!(await assinaturaConfere(req, reply, body.data.senha))) return reply;

    try {
      const r = onInspect(
        db,
        params.data.id,
        {
          resultado: 'REPROVADA',
          motivo: body.data.motivo,
          severidade: body.data.severidade,
          texto: body.data.texto ?? null,
          fotoId: body.data.fotoId ?? null,
        },
        { id: req.user!.id, login: req.user!.login },
        new Date(),
        req.ip,
      );
      return await reply.send(
        paraInspecaoResumo(r.inspecao, req.user!.login, r.retrabalho?.dueDate ?? null),
      );
    } catch (err) {
      if (err instanceof SegregacaoError) return reply.status(403).send({ erro: err.message });
      if (err instanceof InspecaoInvalidaError) return reply.status(409).send({ erro: err.message });
      throw err;
    }
  });

  done();
};

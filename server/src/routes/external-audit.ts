import { asc, desc, eq } from 'drizzle-orm';
import type { FastifyPluginCallback } from 'fastify';
import {
  registrarExternalAuditSchema,
  type ExternalAuditAchado,
  type ExternalAuditResumo,
  type Severidade,
} from '@rhodes/shared';

import type { Db } from '../db/index.js';
import { areas, externalAudit, externalAuditAchados, users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { requireRole } from '../lib/auth.js';

export const externalAuditRoutes: FastifyPluginCallback<{ db: Db }> = (app, opts, done) => {
  const { db } = opts;
  const somenteGestor = requireRole(db, 'GESTOR');

  /** Registra uma inspeção externa (Salso/Ambev) — append-only, transacional. */
  app.post('/api/external-audit', { preHandler: somenteGestor }, (req, reply) => {
    const body = registrarExternalAuditSchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ erro: body.error.issues[0]?.message ?? 'Dados inválidos.' });
    }

    const criada = db.transaction((tx) => {
      const t = tx as unknown as Db;
      const ins = t
        .insert(externalAudit)
        .values({
          orgao: body.data.orgao,
          dataInspecao: body.data.dataInspecao,
          nota: body.data.nota,
          observacao: body.data.observacao ?? null,
          criadoPorId: req.user!.id,
        })
        .returning()
        .get();
      for (const a of body.data.achados) {
        t.insert(externalAuditAchados)
          .values({ auditId: ins.id, areaId: a.areaId ?? null, severidade: a.severidade, descricao: a.descricao })
          .run();
      }
      audit(t, {
        ator: { id: req.user!.id, login: req.user!.login },
        acao: 'EXTERNAL_AUDIT_REGISTRADA',
        entidade: 'external_audit',
        entidadeId: ins.id,
        depois: { orgao: ins.orgao, dataInspecao: ins.dataInspecao, nota: ins.nota, achados: body.data.achados.length },
        ip: req.ip,
      });
      return ins;
    });
    return reply.status(201).send({ id: criada.id });
  });

  /** Lista as inspeções externas, mais recentes primeiro, com achados. */
  app.get('/api/external-audit', { preHandler: somenteGestor }, (_req, reply) => {
    const auditorias = db
      .select({ a: externalAudit, criadoPor: users.login })
      .from(externalAudit)
      .leftJoin(users, eq(externalAudit.criadoPorId, users.id))
      .orderBy(desc(externalAudit.dataInspecao), desc(externalAudit.id))
      .all();

    const achadosRows = db
      .select({ ach: externalAuditAchados, areaNome: areas.nome })
      .from(externalAuditAchados)
      .leftJoin(areas, eq(externalAuditAchados.areaId, areas.id))
      .orderBy(asc(externalAuditAchados.id))
      .all();

    const itens: ExternalAuditResumo[] = auditorias.map((r) => ({
      id: r.a.id,
      orgao: r.a.orgao,
      dataInspecao: r.a.dataInspecao,
      nota: r.a.nota,
      observacao: r.a.observacao,
      criadoPor: r.criadoPor,
      criadoEm: r.a.criadoEm.toISOString(),
      achados: achadosRows
        .filter((x) => x.ach.auditId === r.a.id)
        .map<ExternalAuditAchado>((x) => ({
          areaId: x.ach.areaId,
          areaNome: x.areaNome,
          severidade: x.ach.severidade as Severidade,
          descricao: x.ach.descricao,
        })),
    }));
    return reply.send(itens);
  });

  done();
};

/**
 * Nota externa mais recente por DATA DA INSPEÇÃO (desempate por id) — não por criadoEm (uma
 * inspeção antiga registrada depois não pode vencer). Usada pelo dashboard para o gap.
 */
export function notaExternaMaisRecente(db: Db): { nota: number; orgao: string } | null {
  const r = db
    .select({ nota: externalAudit.nota, orgao: externalAudit.orgao })
    .from(externalAudit)
    .orderBy(desc(externalAudit.dataInspecao), desc(externalAudit.id))
    .get();
  return r ?? null;
}

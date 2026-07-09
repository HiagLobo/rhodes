import { and, asc, desc, eq } from 'drizzle-orm';
import type { FastifyPluginCallback } from 'fastify';
import {
  criarAreaSchema,
  criarProcedimentoSchema,
  editarAreaSchema,
  editarProcedimentoSchema,
  graceDefault,
  INTERVALO_DIAS,
  novaVersaoMetodoSchema,
  scheduleModeDefault,
  type Area,
  type MetodoVersao,
  type Procedimento,
} from '@rhodes/shared';
import { z } from 'zod';

import { dataRecife } from '@rhodes/shared';

import type { Db } from '../db/index.js';
import { areas, metodoVersoes, taskTemplates, users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { requireRole, requireUser } from '../lib/auth.js';
import { abertaDoTemplate, criarInstancia, reancorarAberta } from '../services/scheduler/instancias.js';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const listaQuerySchema = z.object({
  area: z.coerce.number().int().positive().optional(),
  inativos: z.coerce.number().optional(),
});

type TemplateRow = typeof taskTemplates.$inferSelect;
type VersaoRow = typeof metodoVersoes.$inferSelect;

function toArea(a: typeof areas.$inferSelect): Area {
  return { id: a.id, nome: a.nome, pesoCriticidade: a.pesoCriticidade, ativo: a.ativo };
}

function toMetodoVersao(v: VersaoRow, login: string | null): MetodoVersao {
  return {
    id: v.id,
    versao: v.versao,
    texto: v.texto,
    criadoEm: v.criadoEm.toISOString(),
    criadoPor: login,
  };
}

/** Campos operacionais que entram na trilha de auditoria (o método tem trilha própria). */
function operacional(t: TemplateRow) {
  return {
    areaId: t.areaId,
    atividade: t.atividade,
    frequency: t.frequency,
    intervalDays: t.intervalDays,
    scheduleMode: t.scheduleMode,
    graceDays: t.graceDays,
    triggerType: t.triggerType,
    shipPhase: t.shipPhase,
    leadDays: t.leadDays,
    limitacoes: t.limitacoes,
    ativo: t.ativo,
  };
}

/** Regra cruzada validada sobre o estado FINAL (criação ou merge de edição). */
function inconsistenciaGatilho(t: {
  triggerType: string;
  shipPhase: string | null;
}): string | null {
  if ((t.triggerType === 'HYBRID' || t.triggerType === 'SHIP_EVENT') && !t.shipPhase) {
    return 'Gatilho com navio exige a fase (PRE_ARRIVAL ou POST_OPERATION).';
  }
  return null;
}

export const catalogoRoutes: FastifyPluginCallback<{ db: Db }> = (app, opts, done) => {
  const { db } = opts;
  const logado = requireUser(db);
  const somenteGestor = requireRole(db, 'GESTOR');

  function metodoDe(templateId: number, versaoId: number | null): MetodoVersao | null {
    if (versaoId === null) return null;
    const row = db
      .select({ versao: metodoVersoes, login: users.login })
      .from(metodoVersoes)
      .leftJoin(users, eq(metodoVersoes.criadoPorId, users.id))
      .where(eq(metodoVersoes.id, versaoId))
      .get();
    return row ? toMetodoVersao(row.versao, row.login) : null;
  }

  function toProcedimento(t: TemplateRow): Procedimento {
    return {
      id: t.id,
      areaId: t.areaId,
      atividade: t.atividade,
      frequency: t.frequency as Procedimento['frequency'],
      intervalDays: t.intervalDays,
      scheduleMode: t.scheduleMode as Procedimento['scheduleMode'],
      graceDays: t.graceDays,
      triggerType: t.triggerType as Procedimento['triggerType'],
      shipPhase: t.shipPhase as Procedimento['shipPhase'],
      leadDays: t.leadDays,
      limitacoes: t.limitacoes,
      dependsOnTemplateId: t.dependsOnTemplateId,
      minFotosIntervaloMin: t.minFotosIntervaloMin,
      ativo: t.ativo,
      metodoAtual: metodoDe(t.id, t.metodoVersaoAtualId),
    };
  }

  // ------------------------------- leitura (qualquer logado) -------------------------------

  app.get('/api/areas', { preHandler: logado }, () => {
    return db.select().from(areas).orderBy(asc(areas.nome)).all().map(toArea);
  });

  app.get('/api/procedimentos', { preHandler: logado }, (req, reply) => {
    const query = listaQuerySchema.safeParse(req.query);
    if (!query.success) {
      return reply.status(400).send({ erro: 'Parâmetros inválidos.' });
    }
    const filtros = [];
    if (!query.data.inativos) filtros.push(eq(taskTemplates.ativo, true));
    if (query.data.area !== undefined) filtros.push(eq(taskTemplates.areaId, query.data.area));
    const rows = db
      .select()
      .from(taskTemplates)
      .where(filtros.length > 0 ? and(...filtros) : undefined)
      .orderBy(asc(taskTemplates.areaId), asc(taskTemplates.id))
      .all();
    return reply.send(rows.map(toProcedimento));
  });

  app.get('/api/procedimentos/:id', { preHandler: logado }, (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ erro: 'Dados inválidos.' });
    const t = db.select().from(taskTemplates).where(eq(taskTemplates.id, params.data.id)).get();
    if (!t) return reply.status(404).send({ erro: 'Procedimento não encontrado.' });

    const historico = db
      .select({ versao: metodoVersoes, login: users.login })
      .from(metodoVersoes)
      .leftJoin(users, eq(metodoVersoes.criadoPorId, users.id))
      .where(eq(metodoVersoes.templateId, t.id))
      .orderBy(desc(metodoVersoes.versao))
      .all()
      .map((r) => toMetodoVersao(r.versao, r.login));

    return reply.send({ ...toProcedimento(t), historico });
  });

  // ------------------------------- escrita (só GESTOR) -------------------------------

  app.post('/api/areas', { preHandler: somenteGestor }, (req, reply) => {
    const parsed = criarAreaSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ erro: 'Dados inválidos.' });
    const jaExiste = db.select().from(areas).where(eq(areas.nome, parsed.data.nome)).get();
    if (jaExiste) return reply.status(409).send({ erro: 'Já existe uma área com esse nome.' });

    const criada = db
      .insert(areas)
      .values({ nome: parsed.data.nome, pesoCriticidade: parsed.data.pesoCriticidade ?? 1.0 })
      .returning()
      .get();
    audit(db, {
      ator: { id: req.user!.id, login: req.user!.login },
      acao: 'AREA_CRIADA',
      entidade: 'areas',
      entidadeId: criada.id,
      depois: toArea(criada),
      ip: req.ip,
    });
    return reply.status(201).send(toArea(criada));
  });

  app.patch('/api/areas/:id', { preHandler: somenteGestor }, (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    const body = editarAreaSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ erro: 'Dados inválidos.' });
    }
    const antes = db.select().from(areas).where(eq(areas.id, params.data.id)).get();
    if (!antes) return reply.status(404).send({ erro: 'Área não encontrada.' });

    const depois = db
      .update(areas)
      .set({ pesoCriticidade: body.data.pesoCriticidade })
      .where(eq(areas.id, antes.id))
      .returning()
      .get()!;
    // Peso mexe diretamente no score (imutável 7) — antes/depois obrigatórios na trilha.
    audit(db, {
      ator: { id: req.user!.id, login: req.user!.login },
      acao: 'AREA_PESO_ALTERADO',
      entidade: 'areas',
      entidadeId: antes.id,
      antes: toArea(antes),
      depois: toArea(depois),
      ip: req.ip,
    });
    return reply.send(toArea(depois));
  });

  app.post('/api/procedimentos', { preHandler: somenteGestor }, (req, reply) => {
    const parsed = criarProcedimentoSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ erro: 'Dados inválidos.' });
    const d = parsed.data;

    const area = db.select().from(areas).where(eq(areas.id, d.areaId)).get();
    if (!area) return reply.status(404).send({ erro: 'Área não encontrada.' });

    const finalCampos = {
      triggerType: d.triggerType ?? 'CALENDAR',
      shipPhase: d.shipPhase ?? null,
    };
    const problema = inconsistenciaGatilho(finalCampos);
    if (problema) return reply.status(400).send({ erro: problema });

    // NOTA (regra provisória da Onda 02): sem checagem de instâncias abertas — a tabela
    // task_instances nasce na Onda 03 e a política definitiva de edição chega na Onda 07.
    const template = db
      .insert(taskTemplates)
      .values({
        areaId: d.areaId,
        atividade: d.atividade,
        frequency: d.frequency,
        intervalDays: INTERVALO_DIAS[d.frequency],
        scheduleMode: d.scheduleMode ?? scheduleModeDefault(d.frequency),
        graceDays: d.graceDays ?? graceDefault(d.frequency),
        triggerType: finalCampos.triggerType,
        shipPhase: finalCampos.triggerType === 'CALENDAR' ? null : finalCampos.shipPhase,
        leadDays: finalCampos.triggerType === 'CALENDAR' ? null : (d.leadDays ?? 2),
        limitacoes: d.limitacoes ?? null,
        minFotosIntervaloMin: d.minFotosIntervaloMin ?? 5,
      })
      .returning()
      .get();
    const versao = db
      .insert(metodoVersoes)
      .values({ templateId: template.id, versao: 1, texto: d.metodo, criadoPorId: req.user!.id })
      .returning()
      .get();
    const atualizado = db
      .update(taskTemplates)
      .set({ metodoVersaoAtualId: versao.id })
      .where(eq(taskTemplates.id, template.id))
      .returning()
      .get()!;

    audit(db, {
      ator: { id: req.user!.id, login: req.user!.login },
      acao: 'PROCEDIMENTO_CRIADO',
      entidade: 'task_templates',
      entidadeId: template.id,
      depois: operacional(atualizado),
      ip: req.ip,
    });
    return reply.status(201).send(toProcedimento(atualizado));
  });

  app.patch('/api/procedimentos/:id', { preHandler: somenteGestor }, (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    const body = editarProcedimentoSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ erro: 'Dados inválidos.' });
    }
    const antes = db
      .select()
      .from(taskTemplates)
      .where(eq(taskTemplates.id, params.data.id))
      .get();
    if (!antes) return reply.status(404).send({ erro: 'Procedimento não encontrado.' });

    const d = body.data;
    if (d.areaId !== undefined) {
      const area = db.select().from(areas).where(eq(areas.id, d.areaId)).get();
      if (!area) return reply.status(404).send({ erro: 'Área não encontrada.' });
    }

    const frequencyFinal = d.frequency ?? (antes.frequency as keyof typeof INTERVALO_DIAS);
    const mudouFrequencia = d.frequency !== undefined && d.frequency !== antes.frequency;
    const triggerFinal = d.triggerType ?? antes.triggerType;
    const shipPhaseFinal =
      triggerFinal === 'CALENDAR' ? null : (d.shipPhase !== undefined ? d.shipPhase : antes.shipPhase);
    const problema = inconsistenciaGatilho({ triggerType: triggerFinal, shipPhase: shipPhaseFinal });
    if (problema) return reply.status(400).send({ erro: problema });

    const ator = { id: req.user!.id, login: req.user!.login };
    // Template + reancoragem da instância aberta numa SÓ transação (política definitiva da
    // Onda 07/S4 substitui a provisória da 02): editar frequência/modo/carência realinha a
    // aberta; método continua sendo versão nova (rota própria) que não toca a instância.
    const depois = db.transaction((tx) => {
      const t = tx as unknown as Db;
      const editado = t
        .update(taskTemplates)
        .set({
          areaId: d.areaId ?? antes.areaId,
          atividade: d.atividade ?? antes.atividade,
          frequency: frequencyFinal,
          // frequência muda → intervalo SEMPRE re-derivado; tolerância volta ao default da
          // regra dos 10% a menos que o gestor mande graceDays explícito (imutável 4).
          intervalDays: INTERVALO_DIAS[frequencyFinal],
          graceDays: d.graceDays ?? (mudouFrequencia ? graceDefault(frequencyFinal) : antes.graceDays),
          scheduleMode:
            d.scheduleMode ?? (mudouFrequencia ? scheduleModeDefault(frequencyFinal) : antes.scheduleMode),
          triggerType: triggerFinal,
          shipPhase: shipPhaseFinal,
          leadDays:
            triggerFinal === 'CALENDAR' ? null : (d.leadDays !== undefined ? d.leadDays : (antes.leadDays ?? 2)),
          limitacoes: d.limitacoes !== undefined ? d.limitacoes : antes.limitacoes,
          minFotosIntervaloMin: d.minFotosIntervaloMin ?? antes.minFotosIntervaloMin,
        })
        .where(eq(taskTemplates.id, antes.id))
        .returning()
        .get()!;

      audit(t, {
        ator,
        acao: 'PROCEDIMENTO_EDITADO',
        entidade: 'task_templates',
        entidadeId: antes.id,
        antes: operacional(antes),
        depois: operacional(editado),
        ip: req.ip,
      });

      reancorarAberta(
        t,
        editado,
        {
          frequency: antes.frequency,
          scheduleMode: antes.scheduleMode,
          intervalDays: antes.intervalDays,
          graceDays: antes.graceDays,
        },
        ator,
        new Date(),
        req.ip,
      );
      return editado;
    });

    return reply.send(toProcedimento(depois));
  });

  app.post('/api/procedimentos/:id/metodo', { preHandler: somenteGestor }, (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    const body = novaVersaoMetodoSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ erro: 'Dados inválidos.' });
    }
    const template = db
      .select()
      .from(taskTemplates)
      .where(eq(taskTemplates.id, params.data.id))
      .get();
    if (!template) return reply.status(404).send({ erro: 'Procedimento não encontrado.' });

    const ultima = db
      .select({ versao: metodoVersoes.versao })
      .from(metodoVersoes)
      .where(eq(metodoVersoes.templateId, template.id))
      .orderBy(desc(metodoVersoes.versao))
      .get();
    const proxima = (ultima?.versao ?? 0) + 1;

    // A versão anterior fica INTACTA (ALCOA+): só inserimos e movemos o ponteiro.
    const versao = db
      .insert(metodoVersoes)
      .values({
        templateId: template.id,
        versao: proxima,
        texto: body.data.texto,
        criadoPorId: req.user!.id,
      })
      .returning()
      .get();
    db.update(taskTemplates)
      .set({ metodoVersaoAtualId: versao.id })
      .where(eq(taskTemplates.id, template.id))
      .run();

    audit(db, {
      ator: { id: req.user!.id, login: req.user!.login },
      acao: 'METODO_NOVA_VERSAO',
      entidade: 'task_templates',
      entidadeId: template.id,
      depois: { versao: proxima },
      ip: req.ip,
    });
    return reply.status(201).send(metodoDe(template.id, versao.id));
  });

  for (const acao of ['desativar', 'reativar'] as const) {
    app.post(`/api/procedimentos/:id/${acao}`, { preHandler: somenteGestor }, (req, reply) => {
      const params = idParamSchema.safeParse(req.params);
      if (!params.success) return reply.status(400).send({ erro: 'Dados inválidos.' });
      const antes = db
        .select()
        .from(taskTemplates)
        .where(eq(taskTemplates.id, params.data.id))
        .get();
      if (!antes) return reply.status(404).send({ erro: 'Procedimento não encontrado.' });

      const depois = db
        .update(taskTemplates)
        .set({ ativo: acao === 'reativar' })
        .where(eq(taskTemplates.id, antes.id))
        .returning()
        .get()!;
      // Reativar um procedimento que já teve instâncias (todas fechadas) o deixaria órfão —
      // o bootstrap do dailyJob só cobre "zero instâncias" (achado da revisão da Onda 03/S2).
      if (acao === 'reativar' && depois.triggerType !== 'SHIP_EVENT' && !abertaDoTemplate(db, depois.id)) {
        criarInstancia(db, depois, { due: dataRecife(new Date()) });
      }
      audit(db, {
        ator: { id: req.user!.id, login: req.user!.login },
        acao: acao === 'desativar' ? 'PROCEDIMENTO_DESATIVADO' : 'PROCEDIMENTO_REATIVADO',
        entidade: 'task_templates',
        entidadeId: antes.id,
        antes: operacional(antes),
        depois: operacional(depois),
        ip: req.ip,
      });
      return reply.send(toProcedimento(depois));
    });
  }

  done();
};

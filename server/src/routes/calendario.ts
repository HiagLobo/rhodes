import { and, eq, gte, lte } from 'drizzle-orm';
import type { FastifyPluginCallback } from 'fastify';
import {
  calendarioQuerySchema,
  dataRecife,
  type CalendarioPayload,
  type InstanceStatus,
  type OcorrenciaCalendario,
} from '@rhodes/shared';

import type { Db } from '../db/index.js';
import { areas, taskInstances, taskTemplates } from '../db/schema.js';
import { requireUser } from '../lib/auth.js';
import { abertaDoTemplate } from '../services/scheduler/instancias.js';
import { fimDoMes, projetarTemplate } from '../services/scheduler/projecao.js';

/** Meses à frente que a projeção aceita — trava de custo. */
const HORIZONTE_MESES = 12;

function mesDe(data: string): string {
  return data.slice(0, 7);
}

/** Soma `n` meses a um YYYY-MM. */
function somarMeses(mes: string, n: number): string {
  const [y, m] = mes.split('-').map(Number);
  const total = (y! * 12 + (m! - 1)) + n;
  const ano = Math.floor(total / 12);
  const mm = String((total % 12) + 1).padStart(2, '0');
  return `${ano}-${mm}`;
}

export const calendarioRoutes: FastifyPluginCallback<{ db: Db }> = (app, opts, done) => {
  const { db } = opts;
  const logado = requireUser(db);

  app.get('/api/calendario', { preHandler: logado }, (req, reply) => {
    const q = calendarioQuerySchema.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ erro: 'Mês inválido (use YYYY-MM).' });

    const hoje = dataRecife(new Date());
    const mesCorrente = mesDe(hoje);
    const mes = q.data.mes ?? mesCorrente;
    // horizonte: no máximo 12 meses à frente do mês corrente (passado é livre)
    if (mes > somarMeses(mesCorrente, HORIZONTE_MESES)) {
      return reply.status(400).send({ erro: `Projeção limitada a ${HORIZONTE_MESES} meses à frente.` });
    }

    const inicio = `${mes}-01`;
    const fim = fimDoMes(mes);

    // 1) Materializadas do mês (por dueDate) — todas, abertas e fechadas.
    const materializadas = db
      .select({
        dia: taskInstances.dueDate,
        templateId: taskInstances.templateId,
        status: taskInstances.status,
        atividade: taskTemplates.atividade,
        areaNome: areas.nome,
      })
      .from(taskInstances)
      .innerJoin(taskTemplates, eq(taskInstances.templateId, taskTemplates.id))
      .innerJoin(areas, eq(taskTemplates.areaId, areas.id))
      .where(and(gte(taskInstances.dueDate, inicio), lte(taskInstances.dueDate, fim)))
      .all();

    const ocorrencias: OcorrenciaCalendario[] = materializadas.map((m) => ({
      dia: m.dia,
      templateId: m.templateId,
      atividade: m.atividade,
      areaNome: m.areaNome,
      status: m.status as InstanceStatus,
      projetado: false,
    }));

    // 2) Projeção read-only, só para meses que incluem o futuro (nunca reescreve o banco).
    const dependeDeNavio: CalendarioPayload['dependeDeNavio'] = [];
    if (fim >= hoje) {
      const templatesAtivos = db
        .select()
        .from(taskTemplates)
        .where(eq(taskTemplates.ativo, true))
        .all();
      const areaNomePorId = new Map(
        db.select({ id: areas.id, nome: areas.nome }).from(areas).all().map((a) => [a.id, a.nome]),
      );

      for (const t of templatesAtivos) {
        if (t.triggerType === 'SHIP_EVENT') {
          dependeDeNavio.push({ templateId: t.id, atividade: t.atividade, areaNome: areaNomePorId.get(t.areaId) ?? '' });
          continue;
        }
        const aberta = abertaDoTemplate(db, t.id);
        if (!aberta) continue; // sem série viva → nada a projetar
        for (const p of projetarTemplate(t, aberta, hoje, fim)) {
          if (p.dia < inicio) continue; // projeção só entra no mês pedido
          ocorrencias.push({
            dia: p.dia,
            templateId: t.id,
            atividade: t.atividade,
            areaNome: areaNomePorId.get(t.areaId) ?? '',
            status: null,
            projetado: true,
          });
        }
      }
    }

    ocorrencias.sort((a, b) => (a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : a.templateId - b.templateId));
    return reply.send({ mes, ocorrencias, dependeDeNavio });
  });

  done();
};

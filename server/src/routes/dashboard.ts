import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyPluginCallback } from 'fastify';
import {
  dataRecife,
  grupoDaArea,
  GRUPOS_PLANTA,
  situacaoDaInstancia,
  STATUS_ABERTOS,
  type DashboardPayload,
  type GrupoGrade,
  type GrupoPlanta,
  type InstanceStatus,
  type SituacaoGrupo,
} from '@rhodes/shared';

import type { Db } from '../db/index.js';
import { areas, inspections, shipOperations, taskInstances, taskTemplates } from '../db/schema.js';
import { requireUser } from '../lib/auth.js';

/**
 * Filtro de dependência física (Onda 06/S3): a instância dependente de uma rodada só é
 * VISÍVEL depois que a predecessora do mesmo round foi APROVADA. O dashboard usa o MESMO
 * filtro do /api/agora para que cartão, grade e drill-down batam com o que o executante vê.
 */
function predecessoraAprovada() {
  return sql`(
    ${taskTemplates.dependsOnTemplateId} IS NULL
    OR ${taskInstances.roundId} IS NULL
    OR EXISTS (
      SELECT 1 FROM task_instances pred
      JOIN inspections insp ON insp.instance_id = pred.id AND insp.resultado = 'APROVADA'
      WHERE pred.template_id = ${taskTemplates.dependsOnTemplateId}
        AND pred.round_id = ${taskInstances.roundId}
    )
  )`;
}

export const dashboardRoutes: FastifyPluginCallback<{ db: Db }> = (app, opts, done) => {
  const { db } = opts;
  const logado = requireUser(db);

  app.get('/api/dashboard', { preHandler: logado }, (): DashboardPayload => {
    const hoje = dataRecife(new Date()); // dia operacional America/Recife — igual ao dailyJob

    // Instâncias ABERTAS visíveis (mesmo filtro do /api/agora), com área e status.
    const abertas = db
      .select({
        status: taskInstances.status,
        dueDate: taskInstances.dueDate,
        areaNome: areas.nome,
      })
      .from(taskInstances)
      .innerJoin(taskTemplates, eq(taskInstances.templateId, taskTemplates.id))
      .innerJoin(areas, eq(taskTemplates.areaId, areas.id))
      .where(and(inArray(taskInstances.status, [...STATUS_ABERTOS]), predecessoraAprovada()))
      .all();

    // Aguardando vistoria: concluídas SEM inspeção (anti-join da fila da Onda 06).
    const aguardandoVistoria = db
      .select({ n: sql<number>`count(*)` })
      .from(taskInstances)
      .leftJoin(inspections, eq(inspections.instanceId, taskInstances.id))
      .where(
        and(
          inArray(taskInstances.status, ['DONE_ON_TIME', 'DONE_LATE']),
          isNull(inspections.id),
        ),
      )
      .get()!.n;

    let atrasadas = 0;
    let hojeCount = 0;
    // pior situação por grupo (índice numérico: OVERDUE=0 pior … NENHUMA=3 melhor)
    const rank: Record<SituacaoGrupo, number> = { OVERDUE: 0, HOJE: 1, FUTURA: 2, NENHUMA: 3 };
    const acc = new Map<GrupoPlanta, { situacao: SituacaoGrupo; atrasadas: number; hoje: number; abertas: number }>();

    for (const inst of abertas) {
      const sit = situacaoDaInstancia(inst.status as InstanceStatus, inst.dueDate, hoje);
      if (sit === 'OVERDUE') atrasadas += 1;
      // "Hoje" = aberta não-OVERDUE com due ≤ hoje (situacaoDaInstancia já inclui a carência:
      // due passou mas a janela ainda não fechou, logo o dailyJob ainda não marcou OVERDUE).
      if (sit === 'HOJE') hojeCount += 1;

      const grupo = grupoDaArea(inst.areaNome);
      const atual = acc.get(grupo) ?? { situacao: 'NENHUMA' as SituacaoGrupo, atrasadas: 0, hoje: 0, abertas: 0 };
      atual.abertas += 1;
      if (sit === 'OVERDUE') atual.atrasadas += 1;
      if (sit === 'HOJE') atual.hoje += 1;
      if (rank[sit] < rank[atual.situacao]) atual.situacao = sit;
      acc.set(grupo, atual);
    }

    const grade: GrupoGrade[] = GRUPOS_PLANTA.filter((g) => acc.has(g)).map((grupo) => {
      const a = acc.get(grupo)!;
      return { grupo, situacao: a.situacao, atrasadas: a.atrasadas, hoje: a.hoje, abertas: a.abertas };
    });

    // Rodada ativa: operação mais recente não-DESATRACADO (mesmo critério de Navios.tsx).
    const op = db
      .select()
      .from(shipOperations)
      .where(ne(shipOperations.status, 'DESATRACADO'))
      .orderBy(desc(shipOperations.id))
      .get();
    let rodada: DashboardPayload['rodada'] = null;
    if (op) {
      const itens = db
        .select({ status: taskInstances.status })
        .from(taskInstances)
        .where(eq(taskInstances.roundId, op.id))
        .all();
      rodada = {
        operacaoId: op.id,
        navio: op.navio,
        status: op.status,
        etaDate: op.etaDate,
        total: itens.length,
        concluidas: itens.filter((i) => i.status.startsWith('DONE')).length,
      };
    }

    return {
      cartoes: {
        atrasadas,
        hoje: hojeCount,
        aguardandoVistoria,
        score30d: null, // Onda 08
      },
      grade,
      rodada,
    };
  });

  done();
};

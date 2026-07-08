import { and, eq, inArray, lt } from 'drizzle-orm';
import { dataRecife, diaDaSemana } from '@rhodes/shared';

import type { Db } from '../../db/index.js';
import { taskInstances, taskTemplates } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { abertaDoTemplate, criarInstancia } from './instancias.js';

// REGRA DO MÓDULO (Onda 03): determinismo — `agora` SEMPRE chega de fora.

export type ResumoJob = {
  bootstraps: number;
  fixedGeradas: number;
  missed: number;
  overdue: number;
};

/**
 * 2º ponto do motor (arquitetura §4.4) — roda às 00:05 (Recife) e uma vez no boot.
 * Idempotente: rodar N vezes no mesmo dia não duplica nada (a trava de aberta única e as
 * checagens por due garantem). Transacional como o onComplete.
 *
 * Ordem: 1) bootstrap (template sem NENHUMA instância → primeira com due = hoje);
 * 2) FIXED do dia (DIARIO todo dia; SEMANAL na âncora fixed_dow, default segunda) — antes de
 *    criar a de hoje, a aberta ANTIGA vira MISSED (catch-up skip: nunca empilha, mesmo com o
 *    servidor dias desligado); 3) PENDING/IN_PROGRESS com janela vencida viram OVERDUE (uma
 *    transição auditada — FLOATING atrasada fica OVERDUE até conclusão/navio, nunca MISSED aqui).
 */
export function dailyJob(db: Db, agora: Date): ResumoJob {
  return db.transaction((tx) => {
    const t = tx as unknown as Db; // mesmo objeto em runtime; só a tipagem difere
    const hoje = dataRecife(agora);
    const resumo: ResumoJob = { bootstraps: 0, fixedGeradas: 0, missed: 0, overdue: 0 };

    const templates = t
      .select()
      .from(taskTemplates)
      .where(eq(taskTemplates.ativo, true))
      .all()
      .filter((tpl) => tpl.triggerType === 'CALENDAR' || tpl.triggerType === 'HYBRID');

    // 1) bootstrap
    for (const tpl of templates) {
      const alguma = t
        .select({ id: taskInstances.id })
        .from(taskInstances)
        .where(eq(taskInstances.templateId, tpl.id))
        .get();
      if (!alguma) {
        criarInstancia(t, tpl, { due: hoje });
        resumo.bootstraps++;
      }
    }

    // 2) FIXED do dia (o FIXED "genérico" não gera aqui — a série anda pelo onComplete)
    for (const tpl of templates) {
      if (tpl.scheduleMode !== 'FIXED') continue;
      const caiHoje =
        tpl.frequency === 'DIARIO' ||
        (tpl.frequency === 'SEMANAL' && diaDaSemana(hoje) === (tpl.fixedDow ?? 1));
      if (!caiHoje) continue;

      const jaTemDeHoje = t
        .select({ id: taskInstances.id })
        .from(taskInstances)
        .where(and(eq(taskInstances.templateId, tpl.id), eq(taskInstances.dueDate, hoje)))
        .get();
      if (jaTemDeHoje) continue; // idempotência (inclui a recém-bootstrapada)

      const aberta = abertaDoTemplate(t, tpl.id);
      if (aberta && aberta.dueDate < hoje) {
        // catch-up skip: a antiga sai da frente como MISSED (justificável na Onda 05)
        t.update(taskInstances)
          .set({ status: 'MISSED' })
          .where(eq(taskInstances.id, aberta.id))
          .run();
        audit(t, {
          acao: 'INSTANCIA_MISSED',
          entidade: 'task_instances',
          entidadeId: aberta.id,
          antes: { status: aberta.status, dueDate: aberta.dueDate },
          depois: { status: 'MISSED', substituidaPorDue: hoje },
        });
        resumo.missed++;
        criarInstancia(t, tpl, { due: hoje });
        resumo.fixedGeradas++;
      } else if (!aberta) {
        criarInstancia(t, tpl, { due: hoje });
        resumo.fixedGeradas++;
      }
      // aberta com due >= hoje (ex.: override do gestor para o futuro) → respeita a trava
    }

    // 3) OVERDUE — só a transição audita (rodar de novo não re-audita)
    const vencidas = t
      .select()
      .from(taskInstances)
      .where(
        and(
          inArray(taskInstances.status, ['PENDING', 'IN_PROGRESS']),
          lt(taskInstances.windowEnd, hoje),
        ),
      )
      .all();
    for (const inst of vencidas) {
      t.update(taskInstances).set({ status: 'OVERDUE' }).where(eq(taskInstances.id, inst.id)).run();
      audit(t, {
        acao: 'INSTANCIA_OVERDUE',
        entidade: 'task_instances',
        entidadeId: inst.id,
        antes: { status: inst.status, windowEnd: inst.windowEnd },
        depois: { status: 'OVERDUE' },
      });
      resumo.overdue++;
    }

    return resumo;
  });
}

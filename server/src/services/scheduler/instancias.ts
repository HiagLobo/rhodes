import { and, eq, inArray } from 'drizzle-orm';
import { somarDias, STATUS_ABERTOS, type InstanceOrigin } from '@rhodes/shared';

import type { Db } from '../../db/index.js';
import { taskInstances, taskTemplates } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';

export type TemplateRow = typeof taskTemplates.$inferSelect;
export type InstanciaRow = typeof taskInstances.$inferSelect;

/** A instância ABERTA (PENDING/IN_PROGRESS/OVERDUE) do template, se houver — no máximo 1. */
export function abertaDoTemplate(db: Db, templateId: number): InstanciaRow | undefined {
  return db
    .select()
    .from(taskInstances)
    .where(
      and(
        eq(taskInstances.templateId, templateId),
        inArray(taskInstances.status, [...STATUS_ABERTOS]),
      ),
    )
    .get();
}

/**
 * Materializa uma ocorrência. `window_end` é SEMPRE derivado da tolerância do template
 * (regra dos 10% — nunca digitado). Se já houver aberta, o índice único parcial estoura —
 * de propósito: quem chama decide antecipar/fechar antes (imutável 4: nunca empilhar).
 */
export function criarInstancia(
  db: Db,
  template: TemplateRow,
  opts: { due: string; origin?: InstanceOrigin; roundId?: number | null },
): InstanciaRow {
  return db
    .insert(taskInstances)
    .values({
      templateId: template.id,
      dueDate: opts.due,
      windowEnd: somarDias(opts.due, template.graceDays),
      origin: opts.origin ?? 'CALENDAR',
      roundId: opts.roundId ?? null,
    })
    .returning()
    .get();
}

/**
 * Devolve para a fila as IN_PROGRESS presas com um usuário (desativação — imutável 10):
 * voltam a PENDING sem executante, auditadas uma a uma. Retorna quantas liberou.
 */
export function liberarInstanciasDe(db: Db, userId: number, ator: { id: number; login: string }): number {
  const presas = db
    .select()
    .from(taskInstances)
    .where(and(eq(taskInstances.executanteId, userId), eq(taskInstances.status, 'IN_PROGRESS')))
    .all();
  for (const inst of presas) {
    db.update(taskInstances)
      .set({ status: 'PENDING', executanteId: null, startedAt: null })
      .where(eq(taskInstances.id, inst.id))
      .run();
    audit(db, {
      ator,
      acao: 'INSTANCIA_LIBERADA',
      entidade: 'task_instances',
      entidadeId: inst.id,
      antes: { status: 'IN_PROGRESS', executanteId: userId },
      depois: { status: 'PENDING', executanteId: null },
    });
  }
  return presas.length;
}

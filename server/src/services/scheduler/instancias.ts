import { and, eq, inArray } from 'drizzle-orm';
import { somarDias, STATUS_ABERTOS, type InstanceOrigin } from '@rhodes/shared';

import type { Db } from '../../db/index.js';
import { taskInstances, taskTemplates } from '../../db/schema.js';

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

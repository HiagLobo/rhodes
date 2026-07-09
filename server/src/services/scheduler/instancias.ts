import { and, eq, inArray } from 'drizzle-orm';
import { dataRecife, diaDaSemana, somarDias, STATUS_ABERTOS, type InstanceOrigin } from '@rhodes/shared';

import type { Db } from '../../db/index.js';
import { taskInstances, taskTemplates } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';

// REGRA DO MÓDULO (Onda 03): determinismo — `agora`/datas SEMPRE chegam de fora.
// Date.now()/new Date() são proibidos em services/scheduler/ (verificado por grep no CI).

export type TemplateRow = typeof taskTemplates.$inferSelect;
export type InstanciaRow = typeof taskInstances.$inferSelect;

/**
 * Erro de agendamento (dado inconsistente que impede materializar/reancorar). Mora aqui e é
 * RE-EXPORTADO por on-complete.ts como `ConclusaoInvalidaError` — a direção de import é única
 * (on-complete → instancias), sem ciclo.
 */
export class ConclusaoInvalidaError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ConclusaoInvalidaError';
  }
}

/** YYYY-MM-DD compara lexicograficamente — devolve a data mais tarde. */
export function maisTarde(a: string, b: string): string {
  return a >= b ? a : b;
}

/**
 * Próxima âncora FIXED estritamente DEPOIS de `hoje` E do due consumido — conclusão
 * ADIANTADA não regenera o mesmo slot de calendário (achado da revisão adversarial da
 * Onda 03/S2), e dias perdidos são saltados sem empilhar. Movida de on-complete.ts na Onda
 * 07/S4 (a reancoragem e a projeção do calendário reusam esta função — nunca duplicar).
 */
export function proximaAncoraFixed(template: TemplateRow, dueAnterior: string, hoje: string): string {
  if (template.intervalDays <= 0) {
    throw new ConclusaoInvalidaError('Template com intervalo inválido.'); // defesa contra loop
  }
  const base = maisTarde(hoje, dueAnterior);
  if (template.frequency === 'DIARIO') {
    return somarDias(base, 1);
  }
  if (template.frequency === 'SEMANAL') {
    const alvo = template.fixedDow ?? 1; // segunda por default (decisão da Onda 03)
    if (alvo < 0 || alvo > 6) {
      throw new ConclusaoInvalidaError('Âncora semanal (fixed_dow) fora de 0..6.');
    }
    let d = somarDias(base, 1);
    while (diaDaSemana(d) !== alvo) d = somarDias(d, 1);
    return d;
  }
  // Genérico: sempre consome a âncora anterior (≥1 passo) e salta o que ficou no passado.
  let d = somarDias(dueAnterior, template.intervalDays);
  while (d <= hoje) d = somarDias(d, template.intervalDays);
  return d;
}

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

/** O que a reancoragem precisa saber do template ANTES da edição. */
export type TemplateAntes = {
  frequency: string;
  scheduleMode: string;
  intervalDays: number;
  graceDays: number;
};

/**
 * Política DEFINITIVA de edição de template (Onda 07/S4 — substitui a provisória da Onda 02):
 * ao mudar frequência/modo/carência de um procedimento com instância ABERTA, a instância se
 * REALINHA (nunca se cria/deleta — o índice único de 1 aberta é a trava). Regras fixadas:
 * - só reancora aberta PENDING/OVERDUE de origin CALENDAR (IN_PROGRESS = execução em curso;
 *   SHIP = data veio do navio — ambas intactas: a mudança vale para a próxima ocorrência);
 * - `base = dueAtual − intervaloVelho` (usa a due VIGENTE, inclusive se veio de override);
 *   `dueNova = max(base + intervaloNovo, hoje)`; SEMANAL FIXED avança até `fixedDow ?? 1` (se
 *   já cai no dia, FICA); mudança SÓ de graceDays mantém a due e recalcula só o windowEnd;
 * - OVERDUE cuja janela nova ≥ hoje volta a PENDING (o dailyJob nunca faz a transição inversa).
 * Retorna a linha ATUALIZADA da aberta, ou null se nada foi reancorado.
 */
export function reancorarAberta(
  db: Db,
  templateNovo: TemplateRow,
  antes: TemplateAntes,
  ator: { id: number; login: string },
  agora: Date,
  ip?: string,
): InstanciaRow | null {
  const aberta = abertaDoTemplate(db, templateNovo.id);
  if (!aberta) return null;
  if (aberta.origin !== 'CALENDAR') return null; // navio manda na data
  if (aberta.status === 'IN_PROGRESS') return null; // execução em curso

  const mudouSerie =
    templateNovo.frequency !== antes.frequency || templateNovo.scheduleMode !== antes.scheduleMode;
  const mudouGrace = templateNovo.graceDays !== antes.graceDays;
  if (!mudouSerie && !mudouGrace) return null; // só mudou algo que não afeta o agendamento

  const hoje = dataRecife(agora);
  let dueNova: string;
  if (mudouSerie) {
    const base = somarDias(aberta.dueDate, -antes.intervalDays); // "dia zero" da série
    dueNova = maisTarde(somarDias(base, templateNovo.intervalDays), hoje);
    if (templateNovo.scheduleMode === 'FIXED' && templateNovo.frequency === 'SEMANAL') {
      const alvo = templateNovo.fixedDow ?? 1;
      while (diaDaSemana(dueNova) !== alvo) dueNova = somarDias(dueNova, 1); // fica se já cai no dia
    }
  } else {
    dueNova = aberta.dueDate; // só graceDays: due não muda
  }
  const windowEndNova = somarDias(dueNova, templateNovo.graceDays);
  const statusNovo =
    aberta.status === 'OVERDUE' && windowEndNova >= hoje ? 'PENDING' : aberta.status;

  const atualizada = db
    .update(taskInstances)
    .set({ dueDate: dueNova, windowEnd: windowEndNova, status: statusNovo })
    .where(eq(taskInstances.id, aberta.id))
    .returning()
    .get()!;

  audit(db, {
    ator,
    acao: 'INSTANCIA_REANCORADA',
    entidade: 'task_instances',
    entidadeId: aberta.id,
    antes: { dueDate: aberta.dueDate, windowEnd: aberta.windowEnd, status: aberta.status },
    depois: { dueDate: dueNova, windowEnd: windowEndNova, status: statusNovo },
    ip,
  });
  return atualizada;
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

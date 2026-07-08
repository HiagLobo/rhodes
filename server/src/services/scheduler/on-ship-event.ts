import { and, eq, inArray } from 'drizzle-orm';
import { dataRecife, somarDias, type NavioStatus, type ShipPhase } from '@rhodes/shared';

import type { Db } from '../../db/index.js';
import { shipOperations, taskInstances, taskTemplates } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { abertaDoTemplate, criarInstancia, type InstanciaRow } from './instancias.js';

// REGRA DO MÓDULO (Onda 03): determinismo — instantes SEMPRE chegam de fora.

export type Ator = { id: number; login: string };

export type ResultadoShipEvent = {
  criadas: InstanciaRow[];
  antecipadas: InstanciaRow[];
};

function vazio(): ResultadoShipEvent {
  return { criadas: [], antecipadas: [] };
}

function templatesDaFase(db: Db, fase: ShipPhase) {
  return db
    .select()
    .from(taskTemplates)
    .where(
      and(
        eq(taskTemplates.ativo, true),
        inArray(taskTemplates.triggerType, ['HYBRID', 'SHIP_EVENT']),
        eq(taskTemplates.shipPhase, fase),
      ),
    )
    .all();
}

/**
 * Dispara uma fase da rodada: whichever-comes-first (arquitetura §4.3).
 * - aberta existe → ANTECIPA (due = min) e vincula ao round; nunca cria paralela;
 * - sem aberta → cria com origin SHIP e roundId;
 * - já vinculada ao round com due <= alvo → não faz nada (idempotência do evento).
 */
function dispararFase(
  t: Db,
  operacaoId: number,
  fase: ShipPhase,
  alvoDe: (leadDays: number) => string,
  ator: Ator,
  ip?: string,
): ResultadoShipEvent {
  const resultado = vazio();
  for (const tpl of templatesDaFase(t, fase)) {
    const alvo = alvoDe(tpl.leadDays ?? 2);
    const aberta = abertaDoTemplate(t, tpl.id);
    if (!aberta) {
      const criada = criarInstancia(t, tpl, { due: alvo, origin: 'SHIP', roundId: operacaoId });
      audit(t, {
        ator,
        acao: 'INSTANCIA_NAVIO_CRIADA',
        entidade: 'task_instances',
        entidadeId: criada.id,
        depois: { dueDate: alvo, roundId: operacaoId, fase },
        ip,
      });
      resultado.criadas.push(criada);
      continue;
    }
    if (aberta.roundId === operacaoId && aberta.dueDate <= alvo) {
      continue; // evento reprocessado — nada muda
    }
    const novoDue = aberta.dueDate <= alvo ? aberta.dueDate : alvo; // antecipa, nunca adia
    const atualizada = t
      .update(taskInstances)
      .set({
        dueDate: novoDue,
        windowEnd: somarDias(novoDue, tpl.graceDays),
        origin: 'SHIP',
        roundId: operacaoId,
      })
      .where(eq(taskInstances.id, aberta.id))
      .returning()
      .get()!;
    audit(t, {
      ator,
      acao: 'INSTANCIA_NAVIO_ANTECIPADA',
      entidade: 'task_instances',
      entidadeId: aberta.id,
      antes: { dueDate: aberta.dueDate, origin: aberta.origin, roundId: aberta.roundId },
      depois: { dueDate: novoDue, roundId: operacaoId, fase },
      ip,
    });
    resultado.antecipadas.push(atualizada);
  }
  return resultado;
}

/**
 * 3º ponto do motor (arquitetura §4.3): reação às transições da operação de navio.
 * ANUNCIADO → fase PRE_ARRIVAL (due = ETA − lead: pronto ANTES da atracação);
 * DESCARGA_CONCLUIDA → fase POST_OPERATION (due = dia real do evento + lead);
 * demais transições não geram nada (DESATRACADO não re-dispara — a rodada nasce na descarga).
 */
export function onShipEvent(
  db: Db,
  operacaoId: number,
  transicao: NavioStatus,
  eventAt: Date,
  ator: Ator,
  ip?: string,
): ResultadoShipEvent {
  return db.transaction((tx) => {
    const t = tx as unknown as Db;
    const op = t.select().from(shipOperations).where(eq(shipOperations.id, operacaoId)).get();
    if (!op) throw new Error('Operação de navio não encontrada.');

    if (transicao === 'ANUNCIADO') {
      return dispararFase(t, op.id, 'PRE_ARRIVAL', (lead) => somarDias(op.etaDate, -lead), ator, ip);
    }
    if (transicao === 'DESCARGA_CONCLUIDA') {
      const diaDoEvento = dataRecife(eventAt);
      return dispararFase(t, op.id, 'POST_OPERATION', (lead) => somarDias(diaDoEvento, lead), ator, ip);
    }
    return vazio();
  });
}

/**
 * ETA remarcado: REAGENDA (pode adiar ou antecipar) as PRE_ARRIVAL abertas do round —
 * nunca cria novas (arquitetura §4.3).
 */
export function reagendarPreArrival(
  db: Db,
  operacaoId: number,
  novaEta: string,
  ator: Ator,
  ip?: string,
): InstanciaRow[] {
  return db.transaction((tx) => {
    const t = tx as unknown as Db;
    const reagendadas: InstanciaRow[] = [];
    for (const tpl of templatesDaFase(t, 'PRE_ARRIVAL')) {
      const aberta = abertaDoTemplate(t, tpl.id);
      if (!aberta || aberta.roundId !== operacaoId) continue;
      const alvo = somarDias(novaEta, -(tpl.leadDays ?? 2));
      if (aberta.dueDate === alvo) continue;
      const atualizada = t
        .update(taskInstances)
        .set({ dueDate: alvo, windowEnd: somarDias(alvo, tpl.graceDays) })
        .where(eq(taskInstances.id, aberta.id))
        .returning()
        .get()!;
      audit(t, {
        ator,
        acao: 'INSTANCIA_NAVIO_REAGENDADA',
        entidade: 'task_instances',
        entidadeId: aberta.id,
        antes: { dueDate: aberta.dueDate },
        depois: { dueDate: alvo, novaEta },
        ip,
      });
      reagendadas.push(atualizada);
    }
    return reagendadas;
  });
}

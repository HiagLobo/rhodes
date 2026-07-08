import { eq, sql } from 'drizzle-orm';

import type { Db } from '../../db/index.js';
import { execucaoPartes } from '../../db/schema.js';

// REGRA DO MÓDULO (Onda 03): nenhum Date.now()/new Date() em services/scheduler/ —
// instantes sempre chegam de fora (aqui, os received_at do banco).

export class EvidenciaInvalidaError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'EvidenciaInvalidaError';
  }
}

/** O que a validação precisa saber de uma foto — subconjunto da linha de `photos`. */
export type FotoEvidencia = { tipo: string; parte: number; receivedAt: Date };

/**
 * Regra de conclusão (imutável 3, no BACKEND): a parte corrente precisa de ≥1 ANTES e
 * ≥1 DEPOIS, e o intervalo max(DEPOIS)−min(ANTES) — sempre em `received_at` do SERVIDOR —
 * não pode ser menor que o mínimo do template (anti "antes e depois no mesmo minuto").
 */
export function validarEvidencia(
  fotos: FotoEvidencia[],
  parte: number,
  minIntervaloMin: number,
): { tempoSeg: number } {
  const daParte = fotos.filter((f) => f.parte === parte);
  const antes = daParte.filter((f) => f.tipo === 'ANTES');
  const depois = daParte.filter((f) => f.tipo === 'DEPOIS');
  if (antes.length === 0) {
    throw new EvidenciaInvalidaError('Falta a foto de ANTES desta parte da tarefa.');
  }
  if (depois.length === 0) {
    throw new EvidenciaInvalidaError('Falta a foto de DEPOIS desta parte da tarefa.');
  }

  const inicio = Math.min(...antes.map((f) => f.receivedAt.getTime()));
  const fim = Math.max(...depois.map((f) => f.receivedAt.getTime()));
  if (fim - inicio < minIntervaloMin * 60_000) {
    throw new EvidenciaInvalidaError(
      `Menos de ${minIntervaloMin} min entre o ANTES e o DEPOIS — evidência recusada.`,
    );
  }
  return { tempoSeg: Math.round((fim - inicio) / 1000) };
}

/**
 * Tempo total de execução: soma das partes que têm o par ANTES/DEPOIS completo
 * (multi-dia soma os dias; tarefa comum é uma parte só). Sem nenhum par → null.
 */
export function tempoPorPartes(fotos: FotoEvidencia[]): number | null {
  const partes = [...new Set(fotos.map((f) => f.parte))];
  let total = 0;
  let pares = 0;
  for (const parte of partes) {
    const daParte = fotos.filter((f) => f.parte === parte);
    const antes = daParte.filter((f) => f.tipo === 'ANTES');
    const depois = daParte.filter((f) => f.tipo === 'DEPOIS');
    if (antes.length === 0 || depois.length === 0) continue;
    const inicio = Math.min(...antes.map((f) => f.receivedAt.getTime()));
    const fim = Math.max(...depois.map((f) => f.receivedAt.getTime()));
    if (fim > inicio) {
      total += Math.round((fim - inicio) / 1000);
      pares += 1;
    }
  }
  return pares > 0 ? total : null;
}

/** Parte em andamento = partes já fechadas + 1. Upload e conclusão usam a mesma conta. */
export function parteCorrente(db: Db, instanciaId: number): number {
  const r = db
    .select({ n: sql<number>`count(*)` })
    .from(execucaoPartes)
    .where(eq(execucaoPartes.instanceId, instanciaId))
    .get();
  return (r?.n ?? 0) + 1;
}

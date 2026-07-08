import { desc } from 'drizzle-orm';

import type { Db } from '../../db/index.js';
import { scoreConfig } from '../../db/schema.js';

// REGRA DO MÓDULO (Onda 03): sem Date.now()/new Date() — e o sorteio é DETERMINÍSTICO
// de propósito: ninguém "re-sorteia" uma execução até ela cair fora da amostra.

/** Default documentado da vistoria amostral — vale até o gestor versionar outro valor. */
export const PCT_AMOSTRAL_DEFAULT = 10;

/**
 * Sorteio amostral determinístico: FNV-1a do id → 0..99 < pct.
 * Mesmo id decide SEMPRE igual (auditável); ids distintos distribuem ~uniforme.
 * Preparado para ponderação por flags na Onda 11 (o pct pode subir por item).
 */
export function ehAmostral(instanciaId: number, pct: number): boolean {
  if (pct <= 0) return false;
  if (pct >= 100) return true;
  let h = 0x811c9dc5;
  for (const ch of String(instanciaId)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100 < pct;
}

/**
 * Percentual vigente — DADO versionado em score_config (imutável 7): a última linha manda;
 * mudar = inserir linha nova pela API do gestor (auditada desde a Onda 02).
 */
export function lerPctAmostral(db: Db): number {
  const row = db.select().from(scoreConfig).orderBy(desc(scoreConfig.id)).get();
  if (!row) return PCT_AMOSTRAL_DEFAULT;
  try {
    const valores = JSON.parse(row.valores) as { vistoriaAmostralPct?: unknown };
    return typeof valores.vistoriaAmostralPct === 'number'
      ? valores.vistoriaAmostralPct
      : PCT_AMOSTRAL_DEFAULT;
  } catch {
    return PCT_AMOSTRAL_DEFAULT;
  }
}

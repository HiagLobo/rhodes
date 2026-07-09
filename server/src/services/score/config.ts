import { desc } from 'drizzle-orm';
import { DEFAULT_SCORE_CONFIG, scoreConfigSchema, type ScoreConfig } from '@rhodes/shared';

import type { Db } from '../../db/index.js';
import { scoreConfig } from '../../db/schema.js';

/**
 * Config vigente do score — DADO versionado (imutável 7): a última linha de score_config manda.
 * Fail-safe (mesmo padrão de lerPctAmostral): linha ausente ou JSON inválido → o
 * DEFAULT_SCORE_CONFIG do código. A engine (S1) recebe isto por parâmetro.
 */
export function lerScoreConfig(db: Db): ScoreConfig {
  const row = db.select().from(scoreConfig).orderBy(desc(scoreConfig.id)).get();
  if (!row) return DEFAULT_SCORE_CONFIG;
  const parsed = scoreConfigSchema.safeParse(safeJson(row.valores));
  return parsed.success ? parsed.data : DEFAULT_SCORE_CONFIG;
}

function safeJson(texto: string): unknown {
  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}

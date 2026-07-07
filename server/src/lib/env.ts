import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  RHODES_DATA_DIR: z.string().min(1).default('C:\\rhodes-data'),
});

export type Env = {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  /** Diretório de dados (banco, fotos, logs) — obrigatoriamente fora de pasta sincronizada. */
  RHODES_DATA_DIR: string;
  /** Em produção o app só escuta em localhost — o Caddy é a única entrada da rede. */
  HOST: string;
  LOGS_DIR: string;
};

/**
 * Carrega e valida a configuração na subida (fail-fast).
 * Regra inegociável: SQLite corrompe em pasta sincronizada — RHODES_DATA_DIR
 * dentro de OneDrive derruba o boot com erro explicativo.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.parse(source);

  if (!path.isAbsolute(parsed.RHODES_DATA_DIR)) {
    throw new Error(
      `RHODES_DATA_DIR deve ser um caminho absoluto (recebido: "${parsed.RHODES_DATA_DIR}").`,
    );
  }

  const dataDir = path.resolve(parsed.RHODES_DATA_DIR);

  if (/onedrive/i.test(dataDir)) {
    throw new Error(
      `RHODES_DATA_DIR (${dataDir}) está dentro de uma pasta OneDrive/sincronizada. ` +
        'SQLite corrompe em pastas sincronizadas — use um caminho fora do sync, ex.: C:\\rhodes-data',
    );
  }

  const logsDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return {
    NODE_ENV: parsed.NODE_ENV,
    PORT: parsed.PORT,
    RHODES_DATA_DIR: dataDir,
    HOST: parsed.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0',
    LOGS_DIR: logsDir,
  };
}

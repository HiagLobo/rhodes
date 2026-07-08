import cron from 'node-cron';

import { buildApp } from './app.js';
import { createDb, runMigrations } from './db/index.js';
import { loadEnv } from './lib/env.js';
import { createLogger } from './lib/logger.js';
import { dailyJob } from './services/scheduler/daily-job.js';

function fail(err: unknown): never {
  console.error('Falha ao subir o servidor:', err instanceof Error ? err.message : err);
  process.exit(1);
}

try {
  const env = loadEnv();
  const logger = createLogger(env);
  const { db, sqlite } = createDb(env.RHODES_DATA_DIR);
  runMigrations(db);

  const app = buildApp({ db, sqlite, logger, dataDir: env.RHODES_DATA_DIR });

  // Motor: uma execução no boot (servidor religado não espera até amanhã; é idempotente)
  // + cron às 00:05 no fuso do porto (arquitetura §4.4).
  logger.info({ resumo: dailyJob(db, new Date()) }, 'dailyJob (boot)');
  cron.schedule(
    '5 0 * * *',
    () => {
      try {
        logger.info({ resumo: dailyJob(db, new Date()) }, 'dailyJob (cron)');
      } catch (err) {
        logger.error({ err }, 'dailyJob falhou — nova tentativa no próximo ciclo');
      }
    },
    { timezone: 'America/Recife' },
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'encerrando o servidor');
    await app.close();
    sqlite.close(); // fecha com checkpoint do WAL
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: env.PORT, host: env.HOST });
} catch (err) {
  fail(err);
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

// server/drizzle fica a 2 níveis deste arquivo tanto em src/db quanto em dist/db (build da S4).
const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Abre (ou cria) o banco em RHODES_DATA_DIR com os 4 pragmas obrigatórios do projeto. */
export function createDb(dataDir: string): { db: Db; sqlite: Database.Database } {
  const sqlite = new Database(path.join(dataDir, 'rhodes.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

/** Aplica as migrações pendentes (sempre aditivas) — executado no boot, antes de aceitar conexões. */
export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

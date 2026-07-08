import { pathToFileURL } from 'node:url';

import { loadEnv } from '../lib/env.js';
import { hashSenha } from '../lib/passwords.js';
import { createDb, runMigrations, type Db } from './index.js';
import { users } from './schema.js';
import { seedCatalogo } from './seed-catalogo.js';

/**
 * Usuários sintéticos de DESENVOLVIMENTO (imutável 10: seed-first, nunca dado pessoal real).
 * Senha de dev de todos: "cevada-moega-2026" (passa na política NIST; só existe em dev).
 * Papéis como literais de propósito — a S3 integra os contratos de @rhodes/shared no server.
 */
export const SENHA_DEV = 'cevada-moega-2026';

const USUARIOS_DEV = [
  { nome: 'Gestor de Teste', login: 'gestor.teste', role: 'GESTOR' },
  { nome: 'Executante de Teste', login: 'executante.teste', role: 'EXECUTANTE' },
  { nome: 'Vistoriador de Teste', login: 'vistoriador.teste', role: 'VISTORIADOR' },
] as const;

/** Idempotente (upsert por login). Recusa rodar em produção. */
export async function seedDev(db: Db): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seedDev é só para desenvolvimento — NODE_ENV=production detectado.');
  }
  const passwordHash = await hashSenha(SENHA_DEV);
  for (const u of USUARIOS_DEV) {
    db.insert(users)
      .values({ nome: u.nome, login: u.login.toLowerCase(), role: u.role, passwordHash })
      .onConflictDoNothing({ target: users.login })
      .run();
  }
}

const executadoDiretamente =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (executadoDiretamente) {
  const env = loadEnv();
  const { db, sqlite } = createDb(env.RHODES_DATA_DIR);
  runMigrations(db);
  await seedDev(db);
  seedCatalogo(db);
  const total = sqlite.prepare('SELECT COUNT(*) as n FROM users').get() as { n: number };
  const t = sqlite.prepare('SELECT COUNT(*) as n FROM task_templates').get() as { n: number };
  console.log(
    `seed:dev ok — ${total.n} usuários e ${t.n} procedimentos no banco de desenvolvimento`,
  );
  sqlite.close();
}

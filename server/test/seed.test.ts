import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDb, runMigrations } from '../src/db/index.js';
import { seedDev, SENHA_DEV } from '../src/db/seed.js';
import { verificarSenha } from '../src/lib/passwords.js';

function novoBanco() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-seed-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  return { db, sqlite };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('seedDev', () => {
  it('cria os 3 usuários com logins minúsculos, ativos e senha verificável', async () => {
    const { db, sqlite } = novoBanco();
    await seedDev(db);
    const rows = sqlite
      .prepare('SELECT login, role, ativo, password_hash FROM users ORDER BY login')
      .all() as Array<{ login: string; role: string; ativo: number; password_hash: string }>;
    expect(rows.map((r) => r.login)).toEqual([
      'executante.teste',
      'gestor.teste',
      'vistoriador.teste',
    ]);
    expect(new Set(rows.map((r) => r.role))).toEqual(
      new Set(['GESTOR', 'EXECUTANTE', 'VISTORIADOR']),
    );
    expect(rows.every((r) => r.ativo === 1)).toBe(true);
    expect(await verificarSenha(rows[0]!.password_hash, SENHA_DEV)).toBe(true);
    sqlite.close();
  });

  it('é idempotente — rodar 2x resulta em exatamente 3 usuários', async () => {
    const { db, sqlite } = novoBanco();
    await seedDev(db);
    await seedDev(db);
    const { n } = sqlite.prepare('SELECT COUNT(*) as n FROM users').get() as { n: number };
    expect(n).toBe(3);
    sqlite.close();
  });

  it('recusa rodar com NODE_ENV=production', async () => {
    const { db, sqlite } = novoBanco();
    vi.stubEnv('NODE_ENV', 'production');
    await expect(seedDev(db)).rejects.toThrow(/produção|production/);
    sqlite.close();
  });

  it('criado_em vem do default do servidor (não digitado)', async () => {
    const { db, sqlite } = novoBanco();
    await seedDev(db);
    const { criado_em } = sqlite
      .prepare('SELECT criado_em FROM users LIMIT 1')
      .get() as { criado_em: number };
    const agora = Math.floor(Date.now() / 1000);
    expect(Math.abs(agora - criado_em)).toBeLessThan(60);
    sqlite.close();
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDb, runMigrations } from '../src/db/index.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-db-'));
}

describe('createDb', () => {
  it('aplica os 4 pragmas obrigatórios do projeto', () => {
    const { sqlite } = createDb(tmpDir());
    try {
      expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
      expect(sqlite.pragma('synchronous', { simple: true })).toBe(1); // 1 = NORMAL
      expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it('runMigrations cria a tabela meta num banco recém-criado', () => {
    const { db, sqlite } = createDb(tmpDir());
    try {
      runMigrations(db);
      const row = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
        .get();
      expect(row).toBeDefined();
    } finally {
      sqlite.close();
    }
  });

  it('migração é idempotente — rodar 2x não falha nem duplica', () => {
    const { db, sqlite } = createDb(tmpDir());
    try {
      runMigrations(db);
      runMigrations(db);
      const count = sqlite
        .prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table' AND name='meta'")
        .get() as { n: number };
      expect(count.n).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createDb, runMigrations } from '../src/db/index.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { taskInstances } from '../src/db/schema.js';

function bancoSemeado() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-inst-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  seedCatalogo(db);
  return { db, sqlite };
}

function novaInstancia(db: ReturnType<typeof bancoSemeado>['db'], templateId: number, status = 'PENDING') {
  return db
    .insert(taskInstances)
    .values({ templateId, dueDate: '2026-07-08', windowEnd: '2026-07-09', status })
    .returning()
    .get();
}

describe('migração 0005 — task_instances e fixed_dow', () => {
  it('cria a tabela e a coluna aditiva sem tocar nos dados do seed', () => {
    const { sqlite } = bancoSemeado();
    const tabela = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_instances'")
      .get();
    expect(tabela).toBeDefined();

    const colunas = sqlite.prepare('PRAGMA table_info(task_templates)').all() as Array<{
      name: string;
    }>;
    expect(colunas.some((c) => c.name === 'fixed_dow')).toBe(true);

    const { n } = sqlite
      .prepare('SELECT COUNT(*) as n FROM task_templates WHERE fixed_dow IS NOT NULL')
      .get() as { n: number };
    expect(n).toBe(0); // aditiva: os 39 do seed ficam NULL (semanal FIXED usa segunda por default)
    sqlite.close();
  });

  it('TRAVA: 2ª instância aberta do mesmo template falha pelo índice parcial', () => {
    const { db, sqlite } = bancoSemeado();
    novaInstancia(db, 1, 'PENDING');
    expect(() => novaInstancia(db, 1, 'PENDING')).toThrow(/UNIQUE/i);
    sqlite.close();
  });

  it('OVERDUE e IN_PROGRESS também contam como abertas para a trava', () => {
    const { db, sqlite } = bancoSemeado();
    const primeira = novaInstancia(db, 2, 'OVERDUE');
    expect(() => novaInstancia(db, 2, 'PENDING')).toThrow(/UNIQUE/i);
    db.update(taskInstances)
      .set({ status: 'IN_PROGRESS' })
      .where(eq(taskInstances.id, primeira.id))
      .run();
    expect(() => novaInstancia(db, 2, 'PENDING')).toThrow(/UNIQUE/i);
    sqlite.close();
  });

  it('fechada + nova aberta do mesmo template convivem (o índice é PARCIAL)', () => {
    const { db, sqlite } = bancoSemeado();
    const primeira = novaInstancia(db, 3, 'PENDING');
    db.update(taskInstances)
      .set({ status: 'DONE_ON_TIME' })
      .where(eq(taskInstances.id, primeira.id))
      .run();
    const segunda = novaInstancia(db, 3, 'PENDING');
    expect(segunda.id).not.toBe(primeira.id);

    const { n } = sqlite
      .prepare('SELECT COUNT(*) as n FROM task_instances WHERE template_id = 3')
      .get() as { n: number };
    expect(n).toBe(2);
    sqlite.close();
  });

  it('MISSED também libera a trava (substituída sem execução)', () => {
    const { db, sqlite } = bancoSemeado();
    const primeira = novaInstancia(db, 4, 'PENDING');
    db.update(taskInstances)
      .set({ status: 'MISSED' })
      .where(eq(taskInstances.id, primeira.id))
      .run();
    expect(() => novaInstancia(db, 4, 'PENDING')).not.toThrow();
    sqlite.close();
  });

  it('FK de template inválida é rejeitada', () => {
    const { db, sqlite } = bancoSemeado();
    expect(() => novaInstancia(db, 9999)).toThrow();
    sqlite.close();
  });

  it('templates diferentes podem ter abertas simultâneas', () => {
    const { db, sqlite } = bancoSemeado();
    novaInstancia(db, 5, 'PENDING');
    expect(() => novaInstancia(db, 6, 'PENDING')).not.toThrow();
    sqlite.close();
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { graceDefault, INTERVALO_DIAS } from '@rhodes/shared';

import { createDb, runMigrations } from '../src/db/index.js';
import { areas, metodoVersoes, taskTemplates } from '../src/db/schema.js';

function novoBanco() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-catalogo-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  return { db, sqlite };
}

describe('migração 0004 — tabelas do catálogo', () => {
  it('cria as 4 tabelas na cadeia completa de migrações', () => {
    const { sqlite } = novoBanco();
    const nomes = (
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('areas','task_templates','metodo_versoes','score_config')",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(new Set(nomes)).toEqual(
      new Set(['areas', 'task_templates', 'metodo_versoes', 'score_config']),
    );
    sqlite.close();
  });

  it('ciclo template → versão → ponteiro atual funciona (FK circular nullable)', () => {
    const { db, sqlite } = novoBanco();
    const area = db.insert(areas).values({ nome: 'Moega de Recebimento' }).returning().get();
    const template = db
      .insert(taskTemplates)
      .values({
        areaId: area.id,
        atividade: 'Lavagem interna da moega',
        frequency: 'QUINZENAL',
        intervalDays: 14,
        scheduleMode: 'FLOATING',
        graceDays: 1,
        triggerType: 'HYBRID',
        shipPhase: 'POST_OPERATION',
        leadDays: 2,
      })
      .returning()
      .get();
    const versao = db
      .insert(metodoVersoes)
      .values({ templateId: template.id, versao: 1, texto: 'Uso de lava-jato em 100% da limpeza.' })
      .returning()
      .get();
    db.update(taskTemplates)
      .set({ metodoVersaoAtualId: versao.id })
      .where(eq(taskTemplates.id, template.id))
      .run();

    const lido = db.select().from(taskTemplates).where(eq(taskTemplates.id, template.id)).get();
    expect(lido?.metodoVersaoAtualId).toBe(versao.id);
    sqlite.close();
  });

  it('UNIQUE(template_id, versao) rejeita versão duplicada', () => {
    const { db, sqlite } = novoBanco();
    const area = db.insert(areas).values({ nome: 'Silo 01' }).returning().get();
    const t = db
      .insert(taskTemplates)
      .values({
        areaId: area.id,
        atividade: 'Inspeção e limpeza',
        frequency: 'SEMESTRAL',
        intervalDays: 182,
        scheduleMode: 'FLOATING',
        graceDays: 18,
      })
      .returning()
      .get();
    db.insert(metodoVersoes).values({ templateId: t.id, versao: 1, texto: 'v1' }).run();
    expect(() =>
      db.insert(metodoVersoes).values({ templateId: t.id, versao: 1, texto: 'v1 de novo' }).run(),
    ).toThrow(/UNIQUE/i);
    sqlite.close();
  });

  it('score_config bloqueia UPDATE e DELETE (versionada por trigger)', () => {
    const { sqlite } = novoBanco();
    sqlite.prepare("INSERT INTO score_config (valores) VALUES ('{\"pontualidade\":30}')").run();
    expect(() => sqlite.prepare("UPDATE score_config SET valores = '{}'").run()).toThrow(
      /versionada/,
    );
    expect(() => sqlite.prepare('DELETE FROM score_config').run()).toThrow(/versionada/);
    sqlite.close();
  });

  it('FK de área inválida é rejeitada (foreign_keys=ON)', () => {
    const { db, sqlite } = novoBanco();
    expect(() =>
      db
        .insert(taskTemplates)
        .values({
          areaId: 9999,
          atividade: 'X',
          frequency: 'DIARIO',
          intervalDays: 1,
          scheduleMode: 'FIXED',
          graceDays: 0,
        })
        .run(),
    ).toThrow();
    sqlite.close();
  });
});

describe('regra dos 10% (shared)', () => {
  it('INTERVALO_DIAS e graceDefault batem com a arquitetura', () => {
    expect(INTERVALO_DIAS).toEqual({
      DIARIO: 1,
      SEMANAL: 7,
      QUINZENAL: 14,
      MENSAL: 30,
      BIMESTRAL: 61,
      SEMESTRAL: 182,
    });
    expect(
      (['DIARIO', 'SEMANAL', 'QUINZENAL', 'MENSAL', 'BIMESTRAL', 'SEMESTRAL'] as const).map(
        graceDefault,
      ),
    ).toEqual([0, 1, 1, 3, 6, 18]);
  });
});

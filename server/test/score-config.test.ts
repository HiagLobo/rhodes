import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { DEFAULT_SCORE_CONFIG } from '@rhodes/shared';

import { createDb, runMigrations } from '../src/db/index.js';
import { scoreConfig } from '../src/db/schema.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { lerPctAmostral } from '../src/services/scheduler/amostragem.js';
import { lerScoreConfig } from '../src/services/score/config.js';

function novoDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-score-config-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  return { db, sqlite };
}

describe('score_config v1 (seed) + lerScoreConfig', () => {
  it('seed insere a v1; lerScoreConfig devolve os pesos; lerPctAmostral intacto', () => {
    const { db, sqlite } = novoDb();
    seedCatalogo(db);

    const linhas = sqlite.prepare('SELECT COUNT(*) AS n FROM score_config').get() as { n: number };
    expect(linhas.n).toBe(1);

    const cfg = lerScoreConfig(db);
    expect(cfg.pesos).toEqual({ pontualidade: 30, aprovacao: 25, cobertura: 15 });
    expect(cfg.demerito).toEqual({ CRITICA: 8, MAIOR: 3, MENOR: 0 });
    expect(cfg.tetoDemeritos).toBe(20);

    // TESTE-CHAVE: a chave da amostragem (Onda 06) vive no MESMO JSON e não regrediu
    expect(cfg.vistoriaAmostralPct).toBe(DEFAULT_SCORE_CONFIG.vistoriaAmostralPct);
    expect(lerPctAmostral(db)).toBe(DEFAULT_SCORE_CONFIG.vistoriaAmostralPct);
    sqlite.close();
  });

  it('seed é idempotente (rodar 2× não duplica score_config)', () => {
    const { db, sqlite } = novoDb();
    seedCatalogo(db);
    seedCatalogo(db);
    const linhas = sqlite.prepare('SELECT COUNT(*) AS n FROM score_config').get() as { n: number };
    expect(linhas.n).toBe(1);
    sqlite.close();
  });

  it('sem linha → fallback DEFAULT; JSON inválido → fallback', () => {
    const { db, sqlite } = novoDb();
    expect(lerScoreConfig(db)).toEqual(DEFAULT_SCORE_CONFIG); // sem seed

    db.insert(scoreConfig).values({ valores: 'nao-e-json', motivo: 'teste' }).run();
    expect(lerScoreConfig(db)).toEqual(DEFAULT_SCORE_CONFIG); // inválido → default
    sqlite.close();
  });

  it('a última linha (maior id) manda — nova versão muda o config lido', () => {
    const { db, sqlite } = novoDb();
    seedCatalogo(db);
    const nova = { ...DEFAULT_SCORE_CONFIG, pesos: { pontualidade: 40, aprovacao: 20, cobertura: 10 } };
    db.insert(scoreConfig).values({ valores: JSON.stringify(nova), motivo: 'novos pesos' }).run();
    expect(lerScoreConfig(db).pesos.pontualidade).toBe(40);
    sqlite.close();
  });
});

describe('append-only das tabelas de score (imutável 7)', () => {
  it('external_audit: UPDATE e DELETE abortam', () => {
    const { db, sqlite } = novoDb();
    seedCatalogo(db);
    const user = sqlite.prepare("INSERT INTO users (nome, login, password_hash, role) VALUES ('G','g','x','GESTOR') RETURNING id").get() as { id: number };
    sqlite
      .prepare("INSERT INTO external_audit (orgao, data_inspecao, nota, criado_por_id) VALUES ('AMBEV','2026-07-01', 88, ?)")
      .run(user.id);
    expect(() => sqlite.prepare('UPDATE external_audit SET nota = 99 WHERE id = 1').run()).toThrow(/append-only/);
    expect(() => sqlite.prepare('DELETE FROM external_audit WHERE id = 1').run()).toThrow(/append-only/);
    sqlite.close();
  });

  it('demeritos: UPDATE e DELETE abortam', () => {
    const { db, sqlite } = novoDb();
    seedCatalogo(db);
    const user = sqlite.prepare("INSERT INTO users (nome, login, password_hash, role) VALUES ('G','g','x','GESTOR') RETURNING id").get() as { id: number };
    const area = sqlite.prepare('SELECT id FROM areas LIMIT 1').get() as { id: number };
    // inspeção reprovada de referência
    sqlite
      .prepare(
        `INSERT INTO task_instances (template_id, due_date, window_end, status)
         SELECT id, '2026-07-01', '2026-07-01', 'DONE_ON_TIME' FROM task_templates LIMIT 1`,
      )
      .run();
    const inst = sqlite.prepare('SELECT id FROM task_instances LIMIT 1').get() as { id: number };
    sqlite
      .prepare("INSERT INTO inspections (instance_id, resultado, vistoriador_id, severidade) VALUES (?, 'REPROVADA', ?, 'CRITICA')")
      .run(inst.id, user.id);
    const insp = sqlite.prepare('SELECT id FROM inspections LIMIT 1').get() as { id: number };
    sqlite
      .prepare('INSERT INTO demeritos (inspection_id, area_id, severidade, confirmado_por_id) VALUES (?, ?, ?, ?)')
      .run(insp.id, area.id, 'CRITICA', user.id);
    expect(() => sqlite.prepare('UPDATE demeritos SET severidade = ? WHERE id = 1').run('MAIOR')).toThrow(/append-only/);
    expect(() => sqlite.prepare('DELETE FROM demeritos WHERE id = 1').run()).toThrow(/append-only/);
    sqlite.close();
  });
});

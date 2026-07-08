import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDb, runMigrations, type Db } from '../src/db/index.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { areas, taskTemplates } from '../src/db/schema.js';
import { criarInstancia, type TemplateRow } from '../src/services/scheduler/instancias.js';
import { dailyJob } from '../src/services/scheduler/daily-job.js';

/** Meio-dia em Recife (15:00Z) do dia informado. */
function meioDiaRecife(data: string): Date {
  return new Date(`${data}T15:00:00Z`);
}

function bancoVazio() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-dailyjob-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  return { db, sqlite };
}

type TemplateOpts = Partial<typeof taskTemplates.$inferInsert>;

function criarTemplate(db: Db, opts: TemplateOpts = {}): TemplateRow {
  return db
    .insert(taskTemplates)
    .values({
      areaId: 1,
      atividade: 'Tarefa sintética',
      frequency: 'QUINZENAL',
      intervalDays: 14,
      scheduleMode: 'FLOATING',
      graceDays: 1,
      triggerType: 'CALENDAR',
      ...opts,
    })
    .returning()
    .get();
}

describe('dailyJob — bootstrap', () => {
  it('banco recém-semeado: 39 bootstraps com due = hoje (um por procedimento do checklist)', () => {
    const { db, sqlite } = bancoVazio();
    seedCatalogo(db);
    const r = dailyJob(db, meioDiaRecife('2026-07-08'));
    expect(r.bootstraps).toBe(39);
    expect(r.missed).toBe(0);
    expect(r.overdue).toBe(0);

    const { n } = sqlite
      .prepare("SELECT COUNT(*) as n FROM task_instances WHERE due_date = '2026-07-08'")
      .get() as { n: number };
    expect(n).toBe(39);
    sqlite.close();
  });

  it('rodar 2× no MESMO dia → segunda passada zera tudo (idempotência)', () => {
    const { db, sqlite } = bancoVazio();
    seedCatalogo(db);
    dailyJob(db, meioDiaRecife('2026-07-08'));
    const segunda = dailyJob(db, meioDiaRecife('2026-07-08'));
    expect(segunda).toEqual({ bootstraps: 0, fixedGeradas: 0, missed: 0, overdue: 0 });

    const { n } = sqlite.prepare('SELECT COUNT(*) as n FROM task_instances').get() as { n: number };
    expect(n).toBe(39);
    sqlite.close();
  });

  it('template desativado e SHIP_EVENT puro não recebem bootstrap', () => {
    const { db, sqlite } = bancoVazio();
    db.insert(areas).values({ id: 1, nome: 'Área Sintética' }).run();
    criarTemplate(db, { ativo: false });
    criarTemplate(db, { triggerType: 'SHIP_EVENT', shipPhase: 'POST_OPERATION', leadDays: 2 });
    const r = dailyJob(db, meioDiaRecife('2026-07-08'));
    expect(r.bootstraps).toBe(0);
    sqlite.close();
  });
});

describe('dailyJob — FIXED do dia com catch-up MISSED', () => {
  it('diário: no dia seguinte a antiga PENDING vira MISSED e nasce a de hoje (1 aberta só)', () => {
    const { db, sqlite } = bancoVazio();
    db.insert(areas).values({ id: 1, nome: 'Área Sintética' }).run();
    const diario = criarTemplate(db, {
      frequency: 'DIARIO',
      intervalDays: 1,
      scheduleMode: 'FIXED',
      graceDays: 0,
    });
    dailyJob(db, meioDiaRecife('2026-07-08')); // bootstrap due 08/07
    const r = dailyJob(db, meioDiaRecife('2026-07-09'));
    expect(r.missed).toBe(1);
    expect(r.fixedGeradas).toBe(1);

    const rows = sqlite
      .prepare('SELECT due_date, status FROM task_instances WHERE template_id = ? ORDER BY id')
      .all(diario.id) as Array<{ due_date: string; status: string }>;
    expect(rows).toEqual([
      { due_date: '2026-07-08', status: 'MISSED' },
      { due_date: '2026-07-09', status: 'PENDING' },
    ]);
    sqlite.close();
  });

  it('servidor 5 dias desligado: UMA rodada gera só a de hoje + 1 MISSED — nunca 5 instâncias', () => {
    const { db, sqlite } = bancoVazio();
    db.insert(areas).values({ id: 1, nome: 'Área Sintética' }).run();
    const diario = criarTemplate(db, {
      frequency: 'DIARIO',
      intervalDays: 1,
      scheduleMode: 'FIXED',
      graceDays: 0,
    });
    dailyJob(db, meioDiaRecife('2026-07-08'));
    const r = dailyJob(db, meioDiaRecife('2026-07-13')); // pulo direto de 5 dias
    expect(r.missed).toBe(1);
    expect(r.fixedGeradas).toBe(1);

    const { n } = sqlite
      .prepare('SELECT COUNT(*) as n FROM task_instances WHERE template_id = ?')
      .get(diario.id) as { n: number };
    expect(n).toBe(2); // a MISSED e a de hoje — jamais uma por dia perdido
    sqlite.close();
  });

  it('semanal FIXED só nasce no dia da âncora (default segunda)', () => {
    const { db, sqlite } = bancoVazio();
    db.insert(areas).values({ id: 1, nome: 'Área Sintética' }).run();
    const semanal = criarTemplate(db, {
      frequency: 'SEMANAL',
      intervalDays: 7,
      scheduleMode: 'FIXED',
      graceDays: 1,
    });
    // quarta 08/07: bootstrap cria due hoje (regra de partida), mas NÃO é geração de âncora
    dailyJob(db, meioDiaRecife('2026-07-08'));
    // quinta 09/07: nada novo (não é segunda; aberta de quarta segue PENDING na janela)
    const quinta = dailyJob(db, meioDiaRecife('2026-07-09'));
    expect(quinta).toEqual({ bootstraps: 0, fixedGeradas: 0, missed: 0, overdue: 0 });
    // segunda 13/07: âncora — antiga (venceu 09/07... virou OVERDUE antes) vira MISSED, nasce a da segunda
    const segunda = dailyJob(db, meioDiaRecife('2026-07-13'));
    expect(segunda.fixedGeradas).toBe(1);
    expect(segunda.missed).toBe(1);

    const abertas = sqlite
      .prepare(
        "SELECT due_date FROM task_instances WHERE template_id = ? AND status IN ('PENDING','IN_PROGRESS','OVERDUE')",
      )
      .all(semanal.id) as Array<{ due_date: string }>;
    expect(abertas).toEqual([{ due_date: '2026-07-13' }]);
    sqlite.close();
  });

  it('override do gestor para o futuro é respeitado (não gera nem marca MISSED)', () => {
    const { db, sqlite } = bancoVazio();
    db.insert(areas).values({ id: 1, nome: 'Área Sintética' }).run();
    const diario = criarTemplate(db, {
      frequency: 'DIARIO',
      intervalDays: 1,
      scheduleMode: 'FIXED',
      graceDays: 0,
    });
    criarInstancia(db, diario, { due: '2026-07-10' }); // "override" para o futuro
    const r = dailyJob(db, meioDiaRecife('2026-07-09'));
    expect(r.fixedGeradas).toBe(0);
    expect(r.missed).toBe(0);
    sqlite.close();
  });
});

describe('dailyJob — OVERDUE', () => {
  it('FLOATING com janela vencida vira OVERDUE (não MISSED) e audita UMA vez', () => {
    const { db, sqlite } = bancoVazio();
    db.insert(areas).values({ id: 1, nome: 'Área Sintética' }).run();
    const quinzenal = criarTemplate(db); // FLOATING
    criarInstancia(db, quinzenal, { due: '2026-07-01' }); // janela até 02/07

    const r = dailyJob(db, meioDiaRecife('2026-07-08'));
    expect(r.overdue).toBe(1);
    expect(r.missed).toBe(0);

    const { status } = sqlite
      .prepare('SELECT status FROM task_instances WHERE template_id = ?')
      .get(quinzenal.id) as { status: string };
    expect(status).toBe('OVERDUE');

    dailyJob(db, meioDiaRecife('2026-07-09')); // repete: não re-audita
    const { n } = sqlite
      .prepare("SELECT COUNT(*) as n FROM audit_log WHERE acao = 'INSTANCIA_OVERDUE'")
      .get() as { n: number };
    expect(n).toBe(1);
    sqlite.close();
  });

  it('dentro da janela não vira OVERDUE (limite inclusivo: window_end = hoje ainda é prazo)', () => {
    const { db, sqlite } = bancoVazio();
    db.insert(areas).values({ id: 1, nome: 'Área Sintética' }).run();
    const quinzenal = criarTemplate(db);
    criarInstancia(db, quinzenal, { due: '2026-07-07' }); // janela até 08/07
    const r = dailyJob(db, meioDiaRecife('2026-07-08'));
    expect(r.overdue).toBe(0);
    sqlite.close();
  });
});

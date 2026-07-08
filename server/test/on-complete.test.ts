import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createDb, runMigrations, type Db } from '../src/db/index.js';
import { areas, taskInstances, taskTemplates, users } from '../src/db/schema.js';
import { criarInstancia, type TemplateRow } from '../src/services/scheduler/instancias.js';
import { ConclusaoInvalidaError, onComplete } from '../src/services/scheduler/on-complete.js';

const ATOR = { id: 1, login: 'executante.sintetico' };

/** Meio-dia em Recife (15:00Z) do dia informado — instante "seguro" para testes. */
function meioDiaRecife(data: string): Date {
  return new Date(`${data}T15:00:00Z`);
}

function novoBanco() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-oncomplete-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  db.insert(users)
    .values({ id: 1, nome: 'Sintético', login: ATOR.login, passwordHash: 'x', role: 'EXECUTANTE' })
    .run();
  db.insert(areas).values({ id: 1, nome: 'Área Sintética' }).run();
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

describe('onComplete — o exemplo canônico da arquitetura (§4.1)', () => {
  it('quinzenal FLOATING due 14/07 concluída dia 17 → DONE_LATE e próxima dia 31 (17+14), NÃO 28', () => {
    const { db, sqlite } = novoBanco();
    const template = criarTemplate(db);
    const inst = criarInstancia(db, template, { due: '2026-07-14' }); // window 15/07

    const r = onComplete(db, inst.id, ATOR, meioDiaRecife('2026-07-17'));
    expect(r.statusFinal).toBe('DONE_LATE');
    expect(r.proxima?.dueDate).toBe('2026-07-31');
    expect(r.proxima?.windowEnd).toBe('2026-08-01');
    sqlite.close();
  });

  it('concluída EXATAMENTE no window_end → DONE_ON_TIME (limite inclusivo)', () => {
    const { db, sqlite } = novoBanco();
    const template = criarTemplate(db);
    const inst = criarInstancia(db, template, { due: '2026-07-14' });
    const r = onComplete(db, inst.id, ATOR, meioDiaRecife('2026-07-15'));
    expect(r.statusFinal).toBe('DONE_ON_TIME');
    sqlite.close();
  });

  it('o fuso importa: 02:00Z do dia 16 ainda é dia 15 em Recife → DONE_ON_TIME', () => {
    const { db, sqlite } = novoBanco();
    const template = criarTemplate(db);
    const inst = criarInstancia(db, template, { due: '2026-07-14' }); // window 15/07
    const r = onComplete(db, inst.id, ATOR, new Date('2026-07-16T02:00:00Z'));
    expect(r.statusFinal).toBe('DONE_ON_TIME');
    expect(r.proxima?.dueDate).toBe('2026-07-29'); // 15/07 (Recife) + 14
    sqlite.close();
  });

  it('FLOATING 30 dias atrasada → próxima = hoje+14 (nunca no passado, nunca empilha)', () => {
    const { db, sqlite } = novoBanco();
    const template = criarTemplate(db);
    const inst = criarInstancia(db, template, { due: '2026-06-08' });
    const r = onComplete(db, inst.id, ATOR, meioDiaRecife('2026-07-08'));
    expect(r.statusFinal).toBe('DONE_LATE');
    expect(r.proxima?.dueDate).toBe('2026-07-22');

    const { n } = sqlite
      .prepare(
        "SELECT COUNT(*) as n FROM task_instances WHERE template_id = ? AND status = 'PENDING'",
      )
      .get(template.id) as { n: number };
    expect(n).toBe(1);
    sqlite.close();
  });
});

describe('onComplete — FIXED volta para a âncora do calendário', () => {
  it('DIARIO concluído hoje → próxima amanhã', () => {
    const { db, sqlite } = novoBanco();
    const template = criarTemplate(db, {
      frequency: 'DIARIO',
      intervalDays: 1,
      scheduleMode: 'FIXED',
      graceDays: 0,
    });
    const inst = criarInstancia(db, template, { due: '2026-07-08' });
    const r = onComplete(db, inst.id, ATOR, meioDiaRecife('2026-07-08'));
    expect(r.proxima?.dueDate).toBe('2026-07-09');
    sqlite.close();
  });

  it('SEMANAL (âncora default segunda) concluído na quarta → próxima segunda', () => {
    const { db, sqlite } = novoBanco();
    const template = criarTemplate(db, {
      frequency: 'SEMANAL',
      intervalDays: 7,
      scheduleMode: 'FIXED',
      graceDays: 1,
    });
    const inst = criarInstancia(db, template, { due: '2026-07-06' }); // segunda
    const r = onComplete(db, inst.id, ATOR, meioDiaRecife('2026-07-08')); // quarta
    expect(r.proxima?.dueDate).toBe('2026-07-13'); // próxima segunda
    expect(r.statusFinal).toBe('DONE_LATE'); // window era 07/07
    sqlite.close();
  });

  it('SEMANAL com fixed_dow = sexta (5) respeita a âncora configurada', () => {
    const { db, sqlite } = novoBanco();
    const template = criarTemplate(db, {
      frequency: 'SEMANAL',
      intervalDays: 7,
      scheduleMode: 'FIXED',
      graceDays: 1,
      fixedDow: 5,
    });
    const inst = criarInstancia(db, template, { due: '2026-07-10' }); // sexta
    const r = onComplete(db, inst.id, ATOR, meioDiaRecife('2026-07-10'));
    expect(r.proxima?.dueDate).toBe('2026-07-17'); // sexta seguinte
    sqlite.close();
  });

  it('FIXED genérico (quinzenal) com dias perdidos salta para a próxima âncora FUTURA', () => {
    const { db, sqlite } = novoBanco();
    const template = criarTemplate(db, { scheduleMode: 'FIXED' }); // quinzenal FIXED sintético
    const inst = criarInstancia(db, template, { due: '2026-06-10' });
    const r = onComplete(db, inst.id, ATOR, meioDiaRecife('2026-07-08'));
    // âncoras: 24/06, 08/07 (<= hoje, pula), 22/07
    expect(r.proxima?.dueDate).toBe('2026-07-22');
    sqlite.close();
  });

  it('conclusão ADIANTADA não regenera o mesmo slot (achado da revisão adversarial)', () => {
    const { db, sqlite } = novoBanco();
    // FIXED genérico: due 22/07 concluído dia 10/07 → próxima âncora é 05/08, nunca 22/07 de novo
    const generico = criarTemplate(db, { scheduleMode: 'FIXED' });
    const i1 = criarInstancia(db, generico, { due: '2026-07-22' });
    expect(onComplete(db, i1.id, ATOR, meioDiaRecife('2026-07-10')).proxima?.dueDate).toBe(
      '2026-08-05',
    );
    // DIARIO: due amanhã (09/07) concluído hoje → próxima 10/07, não 09/07 duplicado
    const diario = criarTemplate(db, {
      frequency: 'DIARIO',
      intervalDays: 1,
      scheduleMode: 'FIXED',
      graceDays: 0,
    });
    const i2 = criarInstancia(db, diario, { due: '2026-07-09' });
    expect(onComplete(db, i2.id, ATOR, meioDiaRecife('2026-07-08')).proxima?.dueDate).toBe(
      '2026-07-10',
    );
    // SEMANAL: due próxima segunda (13/07) concluído quarta 08/07 → segunda 20/07
    const semanal = criarTemplate(db, {
      frequency: 'SEMANAL',
      intervalDays: 7,
      scheduleMode: 'FIXED',
      graceDays: 1,
    });
    const i3 = criarInstancia(db, semanal, { due: '2026-07-13' });
    expect(onComplete(db, i3.id, ATOR, meioDiaRecife('2026-07-08')).proxima?.dueDate).toBe(
      '2026-07-20',
    );
    sqlite.close();
  });

  it('HYBRID concluída gera a próxima de calendário normalmente', () => {
    const { db, sqlite } = novoBanco();
    const template = criarTemplate(db, {
      triggerType: 'HYBRID',
      shipPhase: 'POST_OPERATION',
      leadDays: 2,
    });
    const inst = criarInstancia(db, template, { due: '2026-07-14' });
    const r = onComplete(db, inst.id, ATOR, meioDiaRecife('2026-07-14'));
    expect(r.proxima?.dueDate).toBe('2026-07-28');
    expect(r.proxima?.origin).toBe('CALENDAR');
    sqlite.close();
  });
});

describe('onComplete — casos de contorno do contrato', () => {
  it('OVERDUE concluída → DONE_LATE + próxima normal', () => {
    const { db, sqlite } = novoBanco();
    const template = criarTemplate(db);
    const inst = criarInstancia(db, template, { due: '2026-07-01' });
    db.update(taskInstances).set({ status: 'OVERDUE' }).where(eq(taskInstances.id, inst.id)).run();
    const r = onComplete(db, inst.id, ATOR, meioDiaRecife('2026-07-08'));
    expect(r.statusFinal).toBe('DONE_LATE');
    expect(r.proxima?.dueDate).toBe('2026-07-22');
    sqlite.close();
  });

  it('template DESATIVADO conclui sem gerar próxima', () => {
    const { db, sqlite } = novoBanco();
    const template = criarTemplate(db);
    const inst = criarInstancia(db, template, { due: '2026-07-08' });
    db.update(taskTemplates).set({ ativo: false }).where(eq(taskTemplates.id, template.id)).run();
    const r = onComplete(db, inst.id, ATOR, meioDiaRecife('2026-07-08'));
    expect(r.proxima).toBeNull();
    sqlite.close();
  });

  it('SHIP_EVENT puro não tem calendário → sem próxima', () => {
    const { db, sqlite } = novoBanco();
    const template = criarTemplate(db, {
      triggerType: 'SHIP_EVENT',
      shipPhase: 'POST_OPERATION',
      leadDays: 2,
    });
    const inst = criarInstancia(db, template, { due: '2026-07-08', origin: 'SHIP' });
    const r = onComplete(db, inst.id, ATOR, meioDiaRecife('2026-07-08'));
    expect(r.proxima).toBeNull();
    sqlite.close();
  });

  it('concluir 2× a mesma instância → ConclusaoInvalidaError', () => {
    const { db, sqlite } = novoBanco();
    const template = criarTemplate(db);
    const inst = criarInstancia(db, template, { due: '2026-07-08' });
    onComplete(db, inst.id, ATOR, meioDiaRecife('2026-07-08'));
    expect(() => onComplete(db, inst.id, ATOR, meioDiaRecife('2026-07-08'))).toThrow(
      ConclusaoInvalidaError,
    );
    sqlite.close();
  });

  it('instância inexistente → ConclusaoInvalidaError', () => {
    const { db, sqlite } = novoBanco();
    expect(() => onComplete(db, 9999, ATOR, meioDiaRecife('2026-07-08'))).toThrow(
      ConclusaoInvalidaError,
    );
    sqlite.close();
  });

  it('grava executante e finished_at do servidor; preserva started_at', () => {
    const { db, sqlite } = novoBanco();
    const template = criarTemplate(db);
    const inst = criarInstancia(db, template, { due: '2026-07-08' });
    const inicio = meioDiaRecife('2026-07-08');
    db.update(taskInstances)
      .set({ status: 'IN_PROGRESS', startedAt: inicio, executanteId: 1 })
      .where(eq(taskInstances.id, inst.id))
      .run();

    const fim = new Date('2026-07-08T16:30:00Z');
    const r = onComplete(db, inst.id, ATOR, fim);
    expect(r.concluida.executanteId).toBe(1);
    expect(r.concluida.startedAt?.getTime()).toBe(inicio.getTime());
    expect(r.concluida.finishedAt?.getTime()).toBe(fim.getTime());
    sqlite.close();
  });

  it('TRANSAÇÃO: falha no meio (audit com ator inexistente → FK) desfaz TUDO', () => {
    const { db, sqlite } = novoBanco();
    const template = criarTemplate(db);
    const inst = criarInstancia(db, template, { due: '2026-07-08' });

    // ator fantasma: update+insert passam, o audit estoura na FK → rollback completo
    expect(() =>
      onComplete(db, inst.id, { id: 9999, login: 'fantasma' }, meioDiaRecife('2026-07-08')),
    ).toThrow();

    const depois = sqlite
      .prepare('SELECT status FROM task_instances WHERE id = ?')
      .get(inst.id) as { status: string };
    expect(depois.status).toBe('PENDING'); // conclusão desfeita
    const { n } = sqlite
      .prepare('SELECT COUNT(*) as n FROM task_instances WHERE template_id = ?')
      .get(template.id) as { n: number };
    expect(n).toBe(1); // próxima desfeita — template não ficou órfão nem duplicado
    sqlite.close();
  });

  it('audita INSTANCIA_CONCLUIDA com ator e antes/depois', () => {
    const { db, sqlite } = novoBanco();
    const template = criarTemplate(db);
    const inst = criarInstancia(db, template, { due: '2026-07-14' });
    onComplete(db, inst.id, ATOR, meioDiaRecife('2026-07-17'), '192.168.1.10');

    const row = sqlite
      .prepare("SELECT ator_login, antes, depois FROM audit_log WHERE acao = 'INSTANCIA_CONCLUIDA'")
      .get() as { ator_login: string; antes: string; depois: string };
    expect(row.ator_login).toBe(ATOR.login);
    expect(JSON.parse(row.antes)).toMatchObject({ status: 'PENDING', dueDate: '2026-07-14' });
    expect(JSON.parse(row.depois)).toMatchObject({ status: 'DONE_LATE', proximaDue: '2026-07-31' });
    sqlite.close();
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDb, runMigrations, type Db } from '../src/db/index.js';
import { areas, shipOperations, taskTemplates, users } from '../src/db/schema.js';
import { criarInstancia, type TemplateRow } from '../src/services/scheduler/instancias.js';
import { onComplete } from '../src/services/scheduler/on-complete.js';
import { onShipEvent, reagendarPreArrival } from '../src/services/scheduler/on-ship-event.js';

const ATOR = { id: 1, login: 'supervisor.s' };

function instante(data: string): Date {
  return new Date(`${data}T15:00:00Z`); // meio-dia em Recife
}

function novoBanco() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-shipev-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  db.insert(users)
    .values({ id: 1, nome: 'S', login: ATOR.login, passwordHash: 'x', role: 'EXECUTANTE' })
    .run();
  db.insert(areas).values({ id: 1, nome: 'Área Sintética' }).run();
  return { db, sqlite };
}

function criarTemplate(db: Db, opts: Partial<typeof taskTemplates.$inferInsert> = {}): TemplateRow {
  return db
    .insert(taskTemplates)
    .values({
      areaId: 1,
      atividade: 'Tarefa híbrida sintética',
      frequency: 'QUINZENAL',
      intervalDays: 14,
      scheduleMode: 'FLOATING',
      graceDays: 1,
      triggerType: 'HYBRID',
      shipPhase: 'POST_OPERATION',
      leadDays: 2,
      ...opts,
    })
    .returning()
    .get();
}

function criarOperacao(db: Db, etaDate = '2026-07-20') {
  return db
    .insert(shipOperations)
    .values({ navio: 'MV Teste', etaDate, criadoPorId: 1 })
    .returning()
    .get();
}

describe('onShipEvent — POST_OPERATION (whichever-comes-first)', () => {
  it('descarga concluída ANTECIPA a quinzenal aberta (due = min) sem duplicar', () => {
    const { db, sqlite } = novoBanco();
    const tpl = criarTemplate(db);
    criarInstancia(db, tpl, { due: '2026-07-20' }); // calendário venceria dia 20
    const op = criarOperacao(db);

    const r = onShipEvent(db, op.id, 'DESCARGA_CONCLUIDA', instante('2026-07-10'), ATOR);
    expect(r.antecipadas.length).toBe(1);
    expect(r.criadas.length).toBe(0);
    expect(r.antecipadas[0]!.dueDate).toBe('2026-07-12'); // evento + lead 2
    expect(r.antecipadas[0]!.origin).toBe('SHIP');
    expect(r.antecipadas[0]!.roundId).toBe(op.id);

    const { n } = sqlite
      .prepare(
        "SELECT COUNT(*) as n FROM task_instances WHERE template_id = ? AND status = 'PENDING'",
      )
      .get(tpl.id) as { n: number };
    expect(n).toBe(1); // nunca paralela
    sqlite.close();
  });

  it('sem aberta → cria com round; evento reprocessado 2× → 2ª passada não muda nada', () => {
    const { db, sqlite } = novoBanco();
    criarTemplate(db);
    const op = criarOperacao(db);

    const r1 = onShipEvent(db, op.id, 'DESCARGA_CONCLUIDA', instante('2026-07-10'), ATOR);
    expect(r1.criadas.length).toBe(1);

    const r2 = onShipEvent(db, op.id, 'DESCARGA_CONCLUIDA', instante('2026-07-10'), ATOR);
    expect(r2.criadas.length).toBe(0);
    expect(r2.antecipadas.length).toBe(0); // idempotência: 1 rodada
    sqlite.close();
  });

  it('aberta que JÁ vence antes do alvo mantém o due mas entra na rodada', () => {
    const { db, sqlite } = novoBanco();
    const tpl = criarTemplate(db);
    criarInstancia(db, tpl, { due: '2026-07-09' }); // antes do alvo 12/07
    const op = criarOperacao(db);

    const r = onShipEvent(db, op.id, 'DESCARGA_CONCLUIDA', instante('2026-07-10'), ATOR);
    expect(r.antecipadas[0]!.dueDate).toBe('2026-07-09'); // nunca adia
    expect(r.antecipadas[0]!.roundId).toBe(op.id);
    sqlite.close();
  });

  it('ATRACADO/DESCARGA_INICIADA/DESATRACADO não disparam nada', () => {
    const { db, sqlite } = novoBanco();
    criarTemplate(db);
    const op = criarOperacao(db);
    for (const t of ['ATRACADO', 'DESCARGA_INICIADA', 'DESATRACADO'] as const) {
      const r = onShipEvent(db, op.id, t, instante('2026-07-10'), ATOR);
      expect(r.criadas.length + r.antecipadas.length, t).toBe(0);
    }
    sqlite.close();
  });

  it('SHIP_EVENT puro só nasce por navio (o dailyJob o ignora)', () => {
    const { db, sqlite } = novoBanco();
    const tpl = criarTemplate(db, { triggerType: 'SHIP_EVENT' });
    const op = criarOperacao(db);
    const r = onShipEvent(db, op.id, 'DESCARGA_CONCLUIDA', instante('2026-07-10'), ATOR);
    expect(r.criadas.length).toBe(1);
    expect(r.criadas[0]!.templateId).toBe(tpl.id);
    sqlite.close();
  });
});

describe('onShipEvent — PRE_ARRIVAL e ETA remarcado', () => {
  it('ANUNCIADO cria com due = ETA − lead (pronto ANTES da atracação)', () => {
    const { db, sqlite } = novoBanco();
    criarTemplate(db, { shipPhase: 'PRE_ARRIVAL', leadDays: 3 });
    const op = criarOperacao(db, '2026-07-20');
    const r = onShipEvent(db, op.id, 'ANUNCIADO', instante('2026-07-08'), ATOR);
    expect(r.criadas[0]!.dueDate).toBe('2026-07-17');
    sqlite.close();
  });

  it('ETA remarcado REAGENDA a mesma instância do round (pode adiar) — nunca cria nova', () => {
    const { db, sqlite } = novoBanco();
    const tpl = criarTemplate(db, { shipPhase: 'PRE_ARRIVAL', leadDays: 3 });
    const op = criarOperacao(db, '2026-07-20');
    onShipEvent(db, op.id, 'ANUNCIADO', instante('2026-07-08'), ATOR);

    const reagendadas = reagendarPreArrival(db, op.id, '2026-07-25', ATOR);
    expect(reagendadas.length).toBe(1);
    expect(reagendadas[0]!.dueDate).toBe('2026-07-22');

    const { n } = sqlite
      .prepare('SELECT COUNT(*) as n FROM task_instances WHERE template_id = ?')
      .get(tpl.id) as { n: number };
    expect(n).toBe(1);
    sqlite.close();
  });
});

describe('reset total na conclusão de instância de navio (§4.3)', () => {
  it('concluir a SHIP reinicia o relógio de hoje — mesmo em template FIXED', () => {
    const { db, sqlite } = novoBanco();
    criarTemplate(db, { scheduleMode: 'FIXED' }); // híbrida FIXED sintética
    const op = criarOperacao(db);
    const r = onShipEvent(db, op.id, 'DESCARGA_CONCLUIDA', instante('2026-07-10'), ATOR);
    const shipInst = r.criadas[0]!;

    const conclusao = onComplete(db, shipInst.id, ATOR, instante('2026-07-13'));
    expect(conclusao.proxima?.dueDate).toBe('2026-07-27'); // hoje (13) + 14 — reset total
    expect(conclusao.proxima?.origin).toBe('CALENDAR'); // volta para a série normal
    sqlite.close();
  });
});

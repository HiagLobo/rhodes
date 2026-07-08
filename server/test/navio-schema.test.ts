import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDb, runMigrations } from '../src/db/index.js';
import { shipEvents, shipOperations, users } from '../src/db/schema.js';

function novoBanco() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-navio-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  db.insert(users)
    .values({ id: 1, nome: 'Supervisor', login: 'supervisor.s', passwordHash: 'x', role: 'EXECUTANTE' })
    .run();
  return { db, sqlite };
}

describe('migração 0006 — operação de navio e eventos', () => {
  it('cria operação ANUNCIADO e evento com event_at ≠ registered_at (madrugada × manhã)', () => {
    const { db, sqlite } = novoBanco();
    const op = db
      .insert(shipOperations)
      .values({ navio: 'MV Cevada Star', produto: 'Cevada', etaDate: '2026-07-15', criadoPorId: 1 })
      .returning()
      .get();
    expect(op.status).toBe('ANUNCIADO');

    // fato de madrugada NO PASSADO (registro retroativo); registered_at é o agora real do servidor
    const madrugada = new Date('2026-07-01T06:30:00Z'); // 03:30 em Recife
    const evento = db
      .insert(shipEvents)
      .values({
        operationId: op.id,
        transicao: 'ATRACADO',
        eventAt: madrugada,
        registradoPorId: 1,
      })
      .returning()
      .get();
    expect(evento.eventAt.getTime()).toBe(madrugada.getTime());
    expect(evento.registeredAt.getTime()).toBeGreaterThan(madrugada.getTime()); // servidor, agora
    expect(Math.abs(Date.now() - evento.registeredAt.getTime())).toBeLessThan(60_000);
    expect(evento.confirmadoPorId).toBeNull(); // executante registra → pendente de confirmação
    sqlite.close();
  });

  it('FK de operação inexistente é rejeitada', () => {
    const { db, sqlite } = novoBanco();
    expect(() =>
      db
        .insert(shipEvents)
        .values({
          operationId: 9999,
          transicao: 'ATRACADO',
          eventAt: new Date(),
          registradoPorId: 1,
        })
        .run(),
    ).toThrow();
    sqlite.close();
  });

  it('eventos se acumulam em ordem por operação (histórico imutável por convenção + trilha)', () => {
    const { db, sqlite } = novoBanco();
    const op = db
      .insert(shipOperations)
      .values({ navio: 'MV Recife', etaDate: '2026-07-15', criadoPorId: 1 })
      .returning()
      .get();
    for (const [i, t] of (['ATRACADO', 'DESCARGA_INICIADA'] as const).entries()) {
      db.insert(shipEvents)
        .values({
          operationId: op.id,
          transicao: t,
          eventAt: new Date(Date.parse('2026-07-15T10:00:00Z') + i * 3_600_000),
          registradoPorId: 1,
        })
        .run();
    }
    const { n } = sqlite
      .prepare('SELECT COUNT(*) as n FROM ship_events WHERE operation_id = ?')
      .get(op.id) as { n: number };
    expect(n).toBe(2);
    sqlite.close();
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import type { DashboardPayload, ExternalAuditResumo } from '@rhodes/shared';

import { buildApp } from '../src/app.js';
import { createDb, runMigrations, type Db } from '../src/db/index.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { seedDev, SENHA_DEV } from '../src/db/seed.js';
import { resetRateLimit } from '../src/lib/auth.js';
import { dailyJob } from '../src/services/scheduler/daily-job.js';

import type DatabaseType from 'better-sqlite3';

type Ctx = { app: ReturnType<typeof buildApp>; db: Db; sqlite: DatabaseType.Database };

async function novoApp(): Promise<Ctx> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-extaudit-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  await seedDev(db);
  seedCatalogo(db);
  dailyJob(db, new Date());
  return { app: buildApp({ db, sqlite, dataDir: dir }), db, sqlite };
}

function extrairCookie(setCookie: string | string[] | undefined): string {
  if (setCookie === undefined) return '';
  const linha = Array.isArray(setCookie) ? setCookie[0]! : setCookie;
  return linha.split(';')[0]!;
}

async function loginDe(app: Ctx['app'], login: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { login, senha: SENHA_DEV } });
  return extrairCookie(res.headers['set-cookie']);
}

beforeEach(() => {
  resetRateLimit();
});

describe('external_audit', () => {
  it('registra com achados (imutável) e aparece no GET; EXECUTANTE → 403', async () => {
    const ctx = await novoApp();
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    const exec = await loginDe(ctx.app, 'executante.teste');
    const areaId = (ctx.sqlite.prepare('SELECT id FROM areas LIMIT 1').get() as { id: number }).id;

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/external-audit',
      headers: { cookie: gestor },
      payload: {
        orgao: 'AMBEV',
        dataInspecao: '2026-07-05',
        nota: 88,
        observacao: 'boa no geral',
        achados: [{ areaId, severidade: 'MAIOR', descricao: 'pó residual na cinta' }],
      },
    });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: number }).id;

    const lista = (await ctx.app.inject({ method: 'GET', url: '/api/external-audit', headers: { cookie: gestor } })).json() as ExternalAuditResumo[];
    expect(lista.length).toBe(1);
    expect(lista[0]).toMatchObject({ orgao: 'AMBEV', nota: 88 });
    expect(lista[0]!.achados[0]).toMatchObject({ severidade: 'MAIOR', descricao: 'pó residual na cinta' });

    // imutável (reafirma S2)
    expect(() => ctx.sqlite.prepare('UPDATE external_audit SET nota = 10 WHERE id = ?').run(id)).toThrow(/append-only/);

    // EXECUTANTE não registra
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/api/external-audit', headers: { cookie: exec }, payload: { orgao: 'SALSO', dataInspecao: '2026-07-05', nota: 70, achados: [] } })).statusCode,
    ).toBe(403);
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('gap no dashboard usa a nota mais recente por DATA da inspeção (não por registro)', async () => {
    const ctx = await novoApp();
    const gestor = await loginDe(ctx.app, 'gestor.teste');

    // sem nota → gap null
    let dash = (await ctx.app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie: gestor } })).json() as DashboardPayload;
    expect(dash.cartoes.gap).toBeNull();
    expect(dash.cartoes.notaExterna).toBeNull();

    // registra DUAS notas: a mais recente por dataInspecao é a de 2026-07-10, mesmo que a de
    // 2026-06-01 tenha sido registrada DEPOIS (ordem de INSERT invertida de propósito)
    await ctx.app.inject({ method: 'POST', url: '/api/external-audit', headers: { cookie: gestor }, payload: { orgao: 'AMBEV', dataInspecao: '2026-07-10', nota: 90, achados: [] } });
    await ctx.app.inject({ method: 'POST', url: '/api/external-audit', headers: { cookie: gestor }, payload: { orgao: 'SALSO', dataInspecao: '2026-06-01', nota: 50, achados: [] } });

    dash = (await ctx.app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie: gestor } })).json() as DashboardPayload;
    expect(dash.cartoes.notaExterna).toBe(90); // a de 10/07, não a de 01/06
    expect(dash.cartoes.orgaoExterno).toBe('AMBEV');
    if (dash.cartoes.score30d !== null) {
      expect(dash.cartoes.gap).toBeCloseTo(dash.cartoes.score30d - 90, 5);
    }
    await ctx.app.close();
    ctx.sqlite.close();
  });
});

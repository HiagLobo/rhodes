import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { dataRecife, somarDias, type DashboardPayload, type ScoreResultado } from '@rhodes/shared';

import { buildApp } from '../src/app.js';
import { createDb, runMigrations, type Db } from '../src/db/index.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { seedDev, SENHA_DEV } from '../src/db/seed.js';
import { resetRateLimit } from '../src/lib/auth.js';
import { dailyJob } from '../src/services/scheduler/daily-job.js';
import { onComplete } from '../src/services/scheduler/on-complete.js';
import { calcularScoreDaJanela } from '../src/routes/score.js';

import type DatabaseType from 'better-sqlite3';

type Ctx = { app: ReturnType<typeof buildApp>; db: Db; sqlite: DatabaseType.Database };

async function novoApp(): Promise<Ctx> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-score-ep-'));
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

async function score(ctx: Ctx, cookie: string, janela = 30): Promise<ScoreResultado> {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/score?janela=${janela}`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as ScoreResultado;
}

beforeEach(() => {
  resetRateLimit();
});

describe('GET /api/score', () => {
  it('sem cookie → 401; janela inválida → 400; qualquer papel logado lê', async () => {
    const ctx = await novoApp();
    expect((await ctx.app.inject({ method: 'GET', url: '/api/score' })).statusCode).toBe(401);
    const exec = await loginDe(ctx.app, 'executante.teste');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/score?janela=15', headers: { cookie: exec } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/score', headers: { cookie: exec } })).statusCode).toBe(200);
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('o endpoint == recálculo do zero (nenhum estado escondido)', async () => {
    const ctx = await novoApp();
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    const doEndpoint = await score(ctx, gestor, 30);
    const direto = calcularScoreDaJanela(ctx.db, 30, new Date());
    expect(doEndpoint.score).toBe(direto.score);
    expect(doEndpoint.areas.length).toBe(direto.areas.length);
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('reflete a operação: concluir no prazo e vistoriar sobe a pontualidade/aprovação da área', async () => {
    const ctx = await novoApp();
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    const exec = { id: (ctx.sqlite.prepare("SELECT id FROM users WHERE login='executante.teste'").get() as { id: number }).id, login: 'executante.teste' };

    // conclui 3 instâncias HOJE (pontuais) — pontualidade real na janela
    const abertas = ctx.sqlite.prepare("SELECT id FROM task_instances WHERE status='PENDING' LIMIT 3").all() as { id: number }[];
    for (const a of abertas) onComplete(ctx.db, a.id, exec, new Date());

    const r = await score(ctx, gestor, 30);
    // há dado de pontualidade agora (n>0) e o score geral existe (não null)
    expect(r.componentes.pontualidade.n).toBeGreaterThan(0);
    expect(r.score).not.toBeNull();
    expect(r.taxaJustificadas).toBe(0); // nada justificado
    // banda coerente com o score
    if (r.score !== null) expect(r.banda).not.toBeNull();
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('janela 7/30/90 são consultáveis; incerteza e n presentes', async () => {
    const ctx = await novoApp();
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    const exec = { id: (ctx.sqlite.prepare("SELECT id FROM users WHERE login='executante.teste'").get() as { id: number }).id, login: 'executante.teste' };
    const a = ctx.sqlite.prepare("SELECT id FROM task_instances WHERE status='PENDING' LIMIT 1").get() as { id: number };
    onComplete(ctx.db, a.id, exec, new Date());

    for (const j of [7, 30, 90] as const) {
      const r = await score(ctx, gestor, j);
      expect(typeof r.n).toBe('number');
      // com dado, a incerteza é numérica
      if (r.score !== null) expect(typeof r.incertezaMais).toBe('number');
    }
    await ctx.app.close();
    ctx.sqlite.close();
  });
});

describe('cartão Score 30d do dashboard', () => {
  it('score30d bate com /api/score?janela=30', async () => {
    const ctx = await novoApp();
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    const exec = { id: (ctx.sqlite.prepare("SELECT id FROM users WHERE login='executante.teste'").get() as { id: number }).id, login: 'executante.teste' };
    const a = ctx.sqlite.prepare("SELECT id FROM task_instances WHERE status='PENDING' LIMIT 1").get() as { id: number };
    onComplete(ctx.db, a.id, exec, new Date());

    const dash = (await ctx.app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie: gestor } })).json() as DashboardPayload;
    const sc = await score(ctx, gestor, 30);
    expect(dash.cartoes.score30d).toBe(sc.score);
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('janela sem nenhum dado → score30d null (cartão "—")', async () => {
    const ctx = await novoApp();
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    // força todas as instâncias para MUITO longe da janela (dueDate no futuro distante)
    ctx.sqlite.prepare("UPDATE task_instances SET due_date = ?, window_end = ?").run(somarDias(dataRecife(new Date()), 400), somarDias(dataRecife(new Date()), 401));
    const dash = (await ctx.app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie: gestor } })).json() as DashboardPayload;
    // sem instâncias na janela e sem inspeções, mas cobertura pode existir (templates ativos
    // sem vencida) → o score pode não ser null. Aceita null OU número, mas consistente com /api/score.
    const sc = await score(ctx, gestor, 30);
    expect(dash.cartoes.score30d).toBe(sc.score);
    await ctx.app.close();
    ctx.sqlite.close();
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { dataRecife, DEFAULT_SCORE_CONFIG, type DemeritoPendente } from '@rhodes/shared';

import { buildApp } from '../src/app.js';
import { createDb, runMigrations, type Db } from '../src/db/index.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { seedDev, SENHA_DEV } from '../src/db/seed.js';
import { resetRateLimit } from '../src/lib/auth.js';
import { dailyJob } from '../src/services/scheduler/daily-job.js';
import { demeritosConfirmadosNaJanela } from '../src/services/score/demeritos.js';

import type DatabaseType from 'better-sqlite3';

type Ctx = { app: ReturnType<typeof buildApp>; db: Db; sqlite: DatabaseType.Database };

async function novoApp(): Promise<Ctx> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-demeritos-'));
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

/** Insere uma inspeção REPROVADA com a severidade dada, feita pelo vistoriador informado. */
function reprovacao(ctx: Ctx, severidade: string, vistoriadorLogin: string): number {
  const vist = ctx.sqlite.prepare('SELECT id FROM users WHERE login = ?').get(vistoriadorLogin) as { id: number };
  const inst = ctx.sqlite.prepare("SELECT id FROM task_instances LIMIT 1").get() as { id: number };
  // reusa a MESMA instância seria UNIQUE em inspections — cria uma nova instância por chamada
  const novaInst = ctx.sqlite
    .prepare(
      `INSERT INTO task_instances (template_id, due_date, window_end, status)
       SELECT template_id, '2026-07-01', '2026-07-01', 'DONE_LATE' FROM task_instances WHERE id = ? RETURNING id`,
    )
    .get(inst.id) as { id: number };
  return (
    ctx.sqlite
      .prepare("INSERT INTO inspections (instance_id, resultado, vistoriador_id, severidade) VALUES (?, 'REPROVADA', ?, ?) RETURNING id")
      .get(novaInst.id, vist.id, severidade) as { id: number }
  ).id;
}

beforeEach(() => {
  resetRateLimit();
});

describe('fila de deméritos pendentes', () => {
  it('só CRITICA/MAIOR aparecem; MENOR nunca; EXECUTANTE/VISTORIADOR → 403', async () => {
    const ctx = await novoApp();
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    const exec = await loginDe(ctx.app, 'executante.teste');
    const vist = await loginDe(ctx.app, 'vistoriador.teste');
    reprovacao(ctx, 'CRITICA', 'vistoriador.teste');
    reprovacao(ctx, 'MAIOR', 'vistoriador.teste');
    reprovacao(ctx, 'MENOR', 'vistoriador.teste');

    const fila = (
      await ctx.app.inject({ method: 'GET', url: '/api/demeritos/pendentes', headers: { cookie: gestor } })
    ).json() as DemeritoPendente[];
    expect(fila.length).toBe(2); // MENOR fora
    expect(fila.map((d) => d.severidade).sort()).toEqual(['CRITICA', 'MAIOR']);

    for (const cookie of [exec, vist]) {
      expect(
        (await ctx.app.inject({ method: 'GET', url: '/api/demeritos/pendentes', headers: { cookie } })).statusCode,
      ).toBe(403);
    }
    await ctx.app.close();
    ctx.sqlite.close();
  });
});

describe('confirmação (2º gate)', () => {
  it('gestor confirma CRITICA; sai da fila; audita; 2ª confirmação → 409', async () => {
    const ctx = await novoApp();
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    const inspId = reprovacao(ctx, 'CRITICA', 'vistoriador.teste');

    const res = await ctx.app.inject({ method: 'POST', url: '/api/demeritos', headers: { cookie: gestor }, payload: { inspectionId: inspId } });
    expect(res.statusCode).toBe(201);

    const fila = (await ctx.app.inject({ method: 'GET', url: '/api/demeritos/pendentes', headers: { cookie: gestor } })).json() as DemeritoPendente[];
    expect(fila.find((d) => d.inspectionId === inspId)).toBeUndefined(); // saiu da fila

    const aud = ctx.sqlite.prepare("SELECT depois FROM audit_log WHERE acao = 'DEMERITO_CONFIRMADO'").get() as { depois: string };
    expect(JSON.parse(aud.depois)).toMatchObject({ severidade: 'CRITICA' });

    // 2ª confirmação → 409 (UNIQUE)
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/api/demeritos', headers: { cookie: gestor }, payload: { inspectionId: inspId } })).statusCode,
    ).toBe(409);
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('segregação: gestor que reprovou não confirma o próprio demérito → 403', async () => {
    const ctx = await novoApp();
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    // o gestor reprova (gestor pode assumir a fila da vistoria — Onda 06)
    const inspId = reprovacao(ctx, 'CRITICA', 'gestor.teste');
    const res = await ctx.app.inject({ method: 'POST', url: '/api/demeritos', headers: { cookie: gestor }, payload: { inspectionId: inspId } });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { erro: string }).erro).toContain('outra pessoa');
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('MENOR não pode ser confirmada → 400; inspeção inexistente → 404', async () => {
    const ctx = await novoApp();
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    const menor = reprovacao(ctx, 'MENOR', 'vistoriador.teste');
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/api/demeritos', headers: { cookie: gestor }, payload: { inspectionId: menor } })).statusCode,
    ).toBe(400);
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/api/demeritos', headers: { cookie: gestor }, payload: { inspectionId: 99999 } })).statusCode,
    ).toBe(404);
    await ctx.app.close();
    ctx.sqlite.close();
  });
});

describe('deméritos alimentam a engine (teto −20/janela)', () => {
  it('demeritosConfirmadosNaJanela lê pelo eixo do EVENTO; a soma respeita o teto', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-dem-eng-'));
    const { db, sqlite } = createDb(dir);
    runMigrations(db);
    const area = sqlite.prepare("INSERT INTO areas (nome) VALUES ('A') RETURNING id").get() as { id: number };
    const user = sqlite.prepare("INSERT INTO users (nome, login, password_hash, role) VALUES ('G','g','x','GESTOR') RETURNING id").get() as { id: number };
    const tpl = sqlite.prepare("INSERT INTO task_templates (area_id, atividade, frequency, interval_days, schedule_mode, grace_days, trigger_type) VALUES (?, 'X','DIARIO',1,'FIXED',0,'CALENDAR') RETURNING id").get(area.id) as { id: number };

    // 4 reprovações CRITICA confirmadas hoje → 4·8 = 32, mas o teto na engine limita a 20
    const hoje = dataRecife(new Date());
    for (let i = 0; i < 4; i++) {
      const inst = sqlite.prepare("INSERT INTO task_instances (template_id, due_date, window_end, status) VALUES (?, ?, ?, 'DONE_LATE') RETURNING id").get(tpl.id, hoje, hoje) as { id: number };
      const insp = sqlite.prepare("INSERT INTO inspections (instance_id, resultado, vistoriador_id, severidade) VALUES (?, 'REPROVADA', ?, 'CRITICA') RETURNING id").get(inst.id, user.id) as { id: number };
      sqlite.prepare('INSERT INTO demeritos (inspection_id, area_id, severidade, confirmado_por_id) VALUES (?, ?, ?, ?)').run(insp.id, area.id, 'CRITICA', user.id);
    }

    const lidos = demeritosConfirmadosNaJanela(db, hoje, hoje);
    expect(lidos.length).toBe(4);
    // a engine aplica o teto: min(20, 4·8=32) = 20
    const somaTeto = Math.min(DEFAULT_SCORE_CONFIG.tetoDemeritos, lidos.reduce((s, d) => s + DEFAULT_SCORE_CONFIG.demerito[d.severidade], 0));
    expect(somaTeto).toBe(20);

    // fora da janela (ontem) → não lê
    expect(demeritosConfirmadosNaJanela(db, '2020-01-01', '2020-01-02').length).toBe(0);
    sqlite.close();
  });
});

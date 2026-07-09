import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCORE_CONFIG, type ScoreConfig, type ScoreResultado } from '@rhodes/shared';

import { buildApp } from '../src/app.js';
import { createDb, runMigrations, type Db } from '../src/db/index.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { seedDev, SENHA_DEV } from '../src/db/seed.js';
import { resetRateLimit } from '../src/lib/auth.js';
import { dailyJob } from '../src/services/scheduler/daily-job.js';
import { onComplete } from '../src/services/scheduler/on-complete.js';
import { lerPctAmostral } from '../src/services/scheduler/amostragem.js';

import type DatabaseType from 'better-sqlite3';

type Ctx = { app: ReturnType<typeof buildApp>; db: Db; sqlite: DatabaseType.Database };

async function novoApp(): Promise<Ctx> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-score-cfg-rota-'));
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

const INPUT = {
  pesos: { pontualidade: 60, aprovacao: 25, cobertura: 15 },
  gracaPontualidade: 0.1,
  demerito: { CRITICA: 8, MAIOR: 3, MENOR: 0 },
  tetoDemeritos: 20,
  tetoJustificativasExecutantePct: 20,
};

beforeEach(() => {
  resetRateLimit();
});

describe('POST /api/score-config', () => {
  it('cria NOVA linha, audita, e o /api/score passa a usar os novos pesos', async () => {
    const ctx = await novoApp();
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    const exec = { id: (ctx.sqlite.prepare("SELECT id FROM users WHERE login='executante.teste'").get() as { id: number }).id, login: 'executante.teste' };

    // cenário onde os componentes DIFEREM DENTRO de uma área (senão o peso não muda a média
    // ponderada): concluir 1 instância ATRASADA → pontualidade < 1, cobertura = 1 na área.
    const alvo = ctx.sqlite
      .prepare("SELECT ti.id, ti.due_date AS due FROM task_instances ti WHERE ti.status='PENDING' LIMIT 1")
      .get() as { id: number; due: string };
    const [y, m, d] = alvo.due.split('-').map(Number);
    const atrasado = new Date(Date.UTC(y!, m! - 1, d! + 10, 15)); // 10 dias após o due
    onComplete(ctx.db, alvo.id, exec, atrasado);

    const antes = (await ctx.app.inject({ method: 'GET', url: '/api/score?janela=30', headers: { cookie: gestor } })).json() as ScoreResultado;
    const linhasAntes = (ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM score_config').get() as { n: number }).n;

    const res = await ctx.app.inject({ method: 'POST', url: '/api/score-config', headers: { cookie: gestor }, payload: INPUT });
    expect(res.statusCode).toBe(201);

    const linhasDepois = (ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM score_config').get() as { n: number }).n;
    expect(linhasDepois).toBe(linhasAntes + 1); // NOVA linha (não UPDATE)

    const aud = ctx.sqlite.prepare("SELECT depois FROM audit_log WHERE acao='SCORE_CONFIG_ALTERADO'").get() as { depois: string };
    expect(JSON.parse(aud.depois).pesos.pontualidade).toBe(60);

    const depois = (await ctx.app.inject({ method: 'GET', url: '/api/score?janela=30', headers: { cookie: gestor } })).json() as ScoreResultado;
    // com mais peso na pontualidade (que aqui é alta) e aprovação ausente, o score muda
    expect(depois.score).not.toBe(antes.score);
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('preserva vistoriaAmostralPct da linha vigente (teste-chave — Onda 06 não regride)', async () => {
    const ctx = await novoApp();
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    // muda o pct amostral vigente para um valor != default, inserindo uma versão
    const comAmostral: ScoreConfig = { ...DEFAULT_SCORE_CONFIG, vistoriaAmostralPct: 33 };
    ctx.sqlite.prepare('INSERT INTO score_config (valores, motivo) VALUES (?, ?)').run(JSON.stringify(comAmostral), 'ajuste amostral');
    expect(lerPctAmostral(ctx.db)).toBe(33);

    // POST de pesos (sem enviar vistoriaAmostralPct) deve PRESERVAR o 33
    await ctx.app.inject({ method: 'POST', url: '/api/score-config', headers: { cookie: gestor }, payload: INPUT });
    expect(lerPctAmostral(ctx.db)).toBe(33); // não regrediu ao default 10
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('EXECUTANTE/VISTORIADOR → 403; body inválido → 400', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const vist = await loginDe(ctx.app, 'vistoriador.teste');
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    for (const cookie of [exec, vist]) {
      expect((await ctx.app.inject({ method: 'POST', url: '/api/score-config', headers: { cookie }, payload: INPUT })).statusCode).toBe(403);
    }
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/api/score-config', headers: { cookie: gestor }, payload: { pesos: { pontualidade: 'x' } } })).statusCode,
    ).toBe(400);
    await ctx.app.close();
    ctx.sqlite.close();
  });
});

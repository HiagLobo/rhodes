import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { dataRecife, somarDias, type CalendarioPayload } from '@rhodes/shared';

import { buildApp } from '../src/app.js';
import { createDb, runMigrations, type Db } from '../src/db/index.js';
import { taskTemplates } from '../src/db/schema.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { seedDev, SENHA_DEV } from '../src/db/seed.js';
import { resetRateLimit } from '../src/lib/auth.js';
import { dailyJob } from '../src/services/scheduler/daily-job.js';
import { onComplete } from '../src/services/scheduler/on-complete.js';
import { abertaDoTemplate, type TemplateRow } from '../src/services/scheduler/instancias.js';
import { projetarTemplate, fimDoMes } from '../src/services/scheduler/projecao.js';

import type DatabaseType from 'better-sqlite3';

type Ctx = { app: ReturnType<typeof buildApp>; db: Db; sqlite: DatabaseType.Database };

async function novoApp(): Promise<Ctx> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-proj-'));
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

async function loginGestor(app: Ctx['app']) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: 'gestor.teste', senha: SENHA_DEV },
  });
  return extrairCookie(res.headers['set-cookie']);
}

/** Instante do meio-dia de Recife de um dia YYYY-MM-DD (para concluir "naquele dia"). */
function meioDiaRecife(dia: string): Date {
  return new Date(`${dia}T15:00:00.000Z`); // 12:00 America/Recife (UTC-3)
}

/** Cria template+aberta e devolve a TemplateRow via DRIZZLE (camelCase — projetar espera isso). */
function templateComAberta(
  ctx: Ctx,
  frequency: string,
  intervalDays: number,
  scheduleMode: string,
  due: string,
  origin = 'CALENDAR',
): TemplateRow {
  let areaId = (ctx.sqlite.prepare('SELECT id FROM areas LIMIT 1').get() as { id: number } | undefined)?.id;
  if (areaId === undefined) {
    areaId = (ctx.sqlite.prepare("INSERT INTO areas (nome) VALUES ('A') RETURNING id").get() as { id: number }).id;
  }
  const templateId = ctx.sqlite
    .prepare(
      `INSERT INTO task_templates (area_id, atividade, frequency, interval_days, schedule_mode,
         grace_days, trigger_type, ativo, min_fotos_intervalo_min)
       VALUES (?, 'Sintética projecao', ?, ?, ?, 1, 'CALENDAR', 1, 5)`,
    )
    .run(areaId, frequency, intervalDays, scheduleMode).lastInsertRowid as number;
  ctx.sqlite
    .prepare(
      `INSERT INTO task_instances (template_id, due_date, window_end, status, origin)
       VALUES (?, ?, ?, 'PENDING', ?)`,
    )
    .run(templateId, due, somarDias(due, 1), origin);
  return ctx.db.select().from(taskTemplates).where(eq(taskTemplates.id, templateId)).get()!;
}

beforeEach(() => {
  resetRateLimit();
});

describe('projeção × motor (igualdade)', () => {
  it('o primeiro dia projetado é EXATAMENTE a próxima due que o motor cria ao concluir', () => {
    // roda como função pura + motor real, sem HTTP
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-proj-eq-'));
    const { db, sqlite } = createDb(dir);
    runMigrations(db);
    const ctx = { app: buildApp({ db, sqlite, dataDir: dir }), db, sqlite };
    // ator real para o audit do onComplete (FK users)
    const sysId = sqlite
      .prepare("INSERT INTO users (nome, login, password_hash, role) VALUES ('Sys','sys','x','GESTOR') RETURNING id")
      .get() as { id: number };
    const hoje = dataRecife(new Date());
    const fim = somarDias(hoje, 400); // horizonte generoso p/ garantir ≥1 item

    const casos = [
      { freq: 'DIARIO', interval: 1, mode: 'FIXED', origin: 'CALENDAR' },
      { freq: 'SEMANAL', interval: 7, mode: 'FIXED', origin: 'CALENDAR' },
      { freq: 'QUINZENAL', interval: 14, mode: 'FLOATING', origin: 'CALENDAR' },
      { freq: 'SEMANAL', interval: 7, mode: 'FIXED', origin: 'SHIP' }, // reset total
    ];
    for (const c of casos) {
      const due = somarDias(hoje, 3);
      const template = templateComAberta(ctx, c.freq, c.interval, c.mode, due, c.origin);
      const aberta = abertaDoTemplate(db, template.id)!;

      const projetado = projetarTemplate(template, aberta, hoje, fim);
      expect(projetado.length, `${c.freq}/${c.origin}`).toBeGreaterThan(0);

      // motor: concluir a aberta NO SEU dia de vencimento
      const r = onComplete(db, aberta.id, { id: sysId.id, login: 'sys' }, meioDiaRecife(due));
      expect(r.proxima, `${c.freq}/${c.origin} gera próxima`).not.toBeNull();
      expect(projetado[0]!.dia, `${c.freq}/${c.origin}`).toBe(r.proxima!.dueDate);
    }
    sqlite.close();
  });

  it('aberta OVERDUE não gera projeção antes de hoje', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-proj-ov-'));
    const { db, sqlite } = createDb(dir);
    runMigrations(db);
    const ctx = { app: buildApp({ db, sqlite, dataDir: dir }), db, sqlite };
    const hoje = dataRecife(new Date());
    const dueVelha = somarDias(hoje, -40);
    const template = templateComAberta(ctx, 'QUINZENAL', 14, 'FLOATING', dueVelha);
    const aberta = abertaDoTemplate(db, template.id)!;

    const projetado = projetarTemplate(template, aberta, hoje, somarDias(hoje, 60));
    expect(projetado.length).toBeGreaterThan(0);
    for (const p of projetado) expect(p.dia >= hoje).toBe(true); // nenhum no passado
    sqlite.close();
  });

  it('intervalDays<=0 é pulado (defesa do motor)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-proj-z-'));
    const { db, sqlite } = createDb(dir);
    runMigrations(db);
    const ctx = { app: buildApp({ db, sqlite, dataDir: dir }), db, sqlite };
    const hoje = dataRecife(new Date());
    const template = templateComAberta(ctx, 'DIARIO', 0, 'FIXED', hoje);
    const aberta = abertaDoTemplate(db, template.id)!;
    expect(projetarTemplate(template, aberta, hoje, somarDias(hoje, 400))).toEqual([]);
    sqlite.close();
  });

  it('fimDoMes calcula o último dia', () => {
    expect(fimDoMes('2026-02')).toBe('2026-02-28');
    expect(fimDoMes('2024-02')).toBe('2024-02-29'); // bissexto
    expect(fimDoMes('2026-12')).toBe('2026-12-31');
  });
});

describe('GET /api/calendario', () => {
  it('não escreve NADA no banco (leitura pura)', async () => {
    const ctx = await novoApp();
    const cookie = await loginGestor(ctx.app);
    const hoje = dataRecife(new Date());

    const antes = (ctx.sqlite.prepare('SELECT count(*) AS n FROM task_instances').get() as { n: number }).n;
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/calendario?mes=${hoje.slice(0, 7)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const dados = res.json() as CalendarioPayload;
    expect(dados.ocorrencias.some((o) => o.projetado)).toBe(true); // tem projeção
    expect(dados.ocorrencias.some((o) => !o.projetado)).toBe(true); // tem materializada

    const depois = (ctx.sqlite.prepare('SELECT count(*) AS n FROM task_instances').get() as { n: number }).n;
    expect(depois).toBe(antes); // ZERO escrita
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('mês inválido → 400; além de 12 meses → 400; default = mês corrente', async () => {
    const ctx = await novoApp();
    const cookie = await loginGestor(ctx.app);
    const hoje = dataRecife(new Date());

    expect((await ctx.app.inject({ method: 'GET', url: '/api/calendario?mes=2026-13', headers: { cookie } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/calendario?mes=abc', headers: { cookie } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/calendario?mes=2099-01', headers: { cookie } })).statusCode).toBe(400);

    const semMes = (await ctx.app.inject({ method: 'GET', url: '/api/calendario', headers: { cookie } })).json() as CalendarioPayload;
    expect(semMes.mes).toBe(hoje.slice(0, 7));
    await ctx.app.close();
    ctx.sqlite.close();
  });
});

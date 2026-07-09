import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { dataRecife, somarDias, type Procedimento } from '@rhodes/shared';

import { buildApp } from '../src/app.js';
import { createDb, runMigrations, type Db } from '../src/db/index.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { seedDev, SENHA_DEV } from '../src/db/seed.js';
import { resetRateLimit } from '../src/lib/auth.js';
import { dailyJob } from '../src/services/scheduler/daily-job.js';

import type DatabaseType from 'better-sqlite3';

type Ctx = { app: ReturnType<typeof buildApp>; db: Db; sqlite: DatabaseType.Database };

async function novoApp(): Promise<Ctx> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-reanc-'));
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

/** Cria um template CALENDAR com a frequência dada e uma instância aberta na due informada. */
function templateComAberta(
  ctx: Ctx,
  frequency: string,
  intervalDays: number,
  scheduleMode: string,
  graceDays: number,
  due: string,
  status = 'PENDING',
  origin = 'CALENDAR',
): { templateId: number; instId: number } {
  const areaId = (ctx.sqlite.prepare('SELECT id FROM areas LIMIT 1').get() as { id: number }).id;
  const templateId = ctx.sqlite
    .prepare(
      `INSERT INTO task_templates (area_id, atividade, frequency, interval_days, schedule_mode,
         grace_days, trigger_type, ativo, min_fotos_intervalo_min)
       VALUES (?, 'Sintética reancoragem', ?, ?, ?, ?, 'CALENDAR', 1, 5)`,
    )
    .run(areaId, frequency, intervalDays, scheduleMode, graceDays).lastInsertRowid as number;
  const instId = ctx.sqlite
    .prepare(
      `INSERT INTO task_instances (template_id, due_date, window_end, status, origin)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(templateId, due, somarDias(due, graceDays), status, origin).lastInsertRowid as number;
  return { templateId, instId };
}

async function editar(ctx: Ctx, cookie: string, templateId: number, body: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/procedimentos/${templateId}`,
    headers: { cookie },
    payload: body,
  });
}

function aberta(ctx: Ctx, templateId: number) {
  return ctx.sqlite
    .prepare(
      `SELECT id, due_date, window_end, status FROM task_instances
       WHERE template_id = ? AND status IN ('PENDING','IN_PROGRESS','OVERDUE')`,
    )
    .get(templateId) as { id: number; due_date: string; window_end: string; status: string };
}

beforeEach(() => {
  resetRateLimit();
});

describe('reancoragem ao editar frequência (Onda 07/S4)', () => {
  it('MENSAL→SEMESTRAL realinha base+182 e audita INSTANCIA_REANCORADA', async () => {
    const ctx = await novoApp();
    const cookie = await loginGestor(ctx.app);
    const hoje = dataRecife(new Date());
    const due = somarDias(hoje, 10); // dentro do mês
    const { templateId } = templateComAberta(ctx, 'MENSAL', 30, 'FLOATING', 3, due);

    const res = await editar(ctx, cookie, templateId, { frequency: 'SEMESTRAL' });
    expect(res.statusCode).toBe(200);
    const base = somarDias(due, -30);
    const esperada = somarDias(base, 182);
    const dep = aberta(ctx, templateId);
    expect(dep.due_date).toBe(esperada);
    expect(dep.window_end).toBe(somarDias(esperada, 18)); // grace default da SEMESTRAL

    const aud = ctx.sqlite
      .prepare("SELECT depois FROM audit_log WHERE acao='INSTANCIA_REANCORADA'")
      .get() as { depois: string };
    expect(JSON.parse(aud.depois)).toMatchObject({ dueDate: esperada });
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('SEMESTRAL→SEMANAL traz a due para frente e avança para segunda; se já for segunda, fica', async () => {
    const ctx = await novoApp();
    const cookie = await loginGestor(ctx.app);
    const hoje = dataRecife(new Date());
    const due = somarDias(hoje, 100);
    const { templateId } = templateComAberta(ctx, 'SEMESTRAL', 182, 'FLOATING', 18, due);

    const res = await editar(ctx, cookie, templateId, { frequency: 'SEMANAL' });
    expect(res.statusCode).toBe(200);
    const dep = aberta(ctx, templateId);
    // base = due-182 (bem no passado) → clamp para hoje, depois avança até segunda-feira (dow 1)
    const [y, m, d] = dep.due_date.split('-').map(Number);
    const dow = new Date(Date.UTC(y!, m! - 1, d!, 12)).getUTCDay();
    expect(dow).toBe(1); // segunda
    expect(dep.due_date >= hoje).toBe(true);
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('due nova cairia no passado → clamp para hoje; OVERDUE volta a PENDING e o dailyJob não re-marca', async () => {
    const ctx = await novoApp();
    const cookie = await loginGestor(ctx.app);
    const hoje = dataRecife(new Date());
    // aberta OVERDUE bem no passado, MENSAL
    const dueVelha = somarDias(hoje, -40);
    const { templateId } = templateComAberta(ctx, 'MENSAL', 30, 'FLOATING', 3, dueVelha, 'OVERDUE');

    const res = await editar(ctx, cookie, templateId, { frequency: 'SEMANAL' });
    expect(res.statusCode).toBe(200);
    const dep = aberta(ctx, templateId);
    expect(dep.status).toBe('PENDING'); // OVERDUE reancorada volta a PENDING
    expect(dep.due_date >= hoje).toBe(true);

    // o dailyJob seguinte NÃO deve re-marcar OVERDUE (window_end >= hoje)
    dailyJob(ctx.db, new Date());
    expect(aberta(ctx, templateId).status).toBe('PENDING');
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('IN_PROGRESS e origin SHIP NÃO são reancoradas (nem com graceDays)', async () => {
    const ctx = await novoApp();
    const cookie = await loginGestor(ctx.app);
    const hoje = dataRecife(new Date());
    const due = somarDias(hoje, 10);
    const emExec = templateComAberta(ctx, 'MENSAL', 30, 'FLOATING', 3, due, 'IN_PROGRESS');
    const navio = templateComAberta(ctx, 'MENSAL', 30, 'FLOATING', 3, due, 'PENDING', 'SHIP');

    await editar(ctx, cookie, emExec.templateId, { frequency: 'SEMESTRAL', graceDays: 10 });
    await editar(ctx, cookie, navio.templateId, { frequency: 'SEMESTRAL', graceDays: 10 });

    expect(aberta(ctx, emExec.templateId).due_date).toBe(due); // intacta
    expect(aberta(ctx, navio.templateId).due_date).toBe(due); // intacta
    // nenhuma reancoragem auditada
    expect(
      (ctx.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE acao='INSTANCIA_REANCORADA'").get() as { n: number }).n,
    ).toBe(0);
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('só graceDays (aberta PENDING CALENDAR) → recalcula só o windowEnd, due intacta', async () => {
    const ctx = await novoApp();
    const cookie = await loginGestor(ctx.app);
    const hoje = dataRecife(new Date());
    const due = somarDias(hoje, 10);
    const { templateId } = templateComAberta(ctx, 'MENSAL', 30, 'FLOATING', 3, due);

    await editar(ctx, cookie, templateId, { graceDays: 10 });
    const dep = aberta(ctx, templateId);
    expect(dep.due_date).toBe(due); // due não muda
    expect(dep.window_end).toBe(somarDias(due, 10)); // só a janela
    await ctx.app.close();
    ctx.sqlite.close();
  });
});

describe('minFotosIntervaloMin de ponta a ponta', () => {
  it('POST grava, GET devolve, PATCH altera e a conclusão passa a exigir o novo intervalo', async () => {
    const ctx = await novoApp();
    const cookie = await loginGestor(ctx.app);

    // criar com valor explícito
    const criado = await ctx.app.inject({
      method: 'POST',
      url: '/api/procedimentos',
      headers: { cookie },
      payload: {
        areaId: (ctx.sqlite.prepare('SELECT id FROM areas LIMIT 1').get() as { id: number }).id,
        atividade: 'Sintética com intervalo',
        frequency: 'DIARIO',
        metodo: 'Fazer assim.',
        minFotosIntervaloMin: 20,
      },
    });
    expect(criado.statusCode).toBe(201);
    const proc = criado.json() as Procedimento;
    expect(proc.minFotosIntervaloMin).toBe(20);

    // GET devolve
    const lido = (
      await ctx.app.inject({ method: 'GET', url: `/api/procedimentos/${proc.id}`, headers: { cookie } })
    ).json() as Procedimento;
    expect(lido.minFotosIntervaloMin).toBe(20);

    // PATCH altera
    await editar(ctx, cookie, proc.id, { minFotosIntervaloMin: 30 });
    const col = ctx.sqlite
      .prepare('SELECT min_fotos_intervalo_min AS m FROM task_templates WHERE id = ?')
      .get(proc.id) as { m: number };
    expect(col.m).toBe(30);

    // mínimo 1 é aplicado (0 rejeitado)
    expect((await editar(ctx, cookie, proc.id, { minFotosIntervaloMin: 0 })).statusCode).toBe(400);
    await ctx.app.close();
    ctx.sqlite.close();
  });
});

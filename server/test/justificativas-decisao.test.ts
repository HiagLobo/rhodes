import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import type { InstanciaResumo, JustificativaFilaItem, JustificativaResumo } from '@rhodes/shared';

import { buildApp } from '../src/app.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { seedDev, SENHA_DEV } from '../src/db/seed.js';
import { resetRateLimit } from '../src/lib/auth.js';
import { dailyJob } from '../src/services/scheduler/daily-job.js';

async function novoApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-just-dec-'));
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

type Ctx = Awaited<ReturnType<typeof novoApp>>;

async function loginDe(app: Ctx['app'], login: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login, senha: SENHA_DEV },
  });
  return extrairCookie(res.headers['set-cookie']);
}

/** Justifica uma tarefa aberta com o motivo dado e devolve o id da justificativa criada. */
async function justificar(ctx: Ctx, execCookie: string, motivo: string, texto?: string): Promise<number> {
  const agora = (
    await ctx.app.inject({ method: 'GET', url: '/api/agora', headers: { cookie: execCookie } })
  ).json() as InstanciaResumo[];
  const alvo = agora[0]!;
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/instancias/${alvo.id}/justificar`,
    headers: { cookie: execCookie },
    payload: { motivo, texto },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { justificativaId: number }).justificativaId;
}

function proximaDueDaJustificada(ctx: Ctx, justificativaId: number): string {
  const j = ctx.sqlite.prepare('SELECT instance_id FROM justificativas WHERE id = ?').get(justificativaId) as { instance_id: number };
  const inst = ctx.sqlite.prepare('SELECT template_id FROM task_instances WHERE id = ?').get(j.instance_id) as { template_id: number };
  const proxima = ctx.sqlite
    .prepare("SELECT due_date FROM task_instances WHERE template_id = ? AND status IN ('PENDING','IN_PROGRESS','OVERDUE')")
    .get(inst.template_id) as { due_date: string };
  return proxima.due_date;
}

beforeEach(() => {
  resetRateLimit();
});

describe('decisão de justificativa (Onda 07)', () => {
  it('aprovar motivo externo grava classificacao derivada + decidido_* e audita', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    const jid = await justificar(ctx, exec, 'NAVIO_OPERANDO');

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/justificativas/${jid}/decisao`,
      headers: { cookie: gestor },
      payload: { decisao: 'APROVADA', obs: 'navio ainda na moega' },
    });
    expect(res.statusCode).toBe(200);
    const dec = res.json() as JustificativaResumo;
    expect(dec.status).toBe('APROVADA');
    expect(dec.classificacao).toBe('EXTERNA'); // derivada do motivo
    expect(dec.decididoPor).toBe('gestor.teste');
    expect(dec.decisaoObs).toBe('navio ainda na moega');

    const auditoria = ctx.sqlite
      .prepare("SELECT depois FROM audit_log WHERE acao = 'JUSTIFICATIVA_APROVADA'")
      .get() as { depois: string };
    expect(JSON.parse(auditoria.depois)).toMatchObject({ classificacao: 'EXTERNA' });
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('a decisão NÃO altera a data da próxima instância (já criada no onJustify)', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    const jid = await justificar(ctx, exec, 'CHUVA');

    const dueAntes = proximaDueDaJustificada(ctx, jid);
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/justificativas/${jid}/decisao`,
      headers: { cookie: gestor },
      payload: { decisao: 'APROVADA' },
    });
    expect(proximaDueDaJustificada(ctx, jid)).toBe(dueAntes); // intacta
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('OUTRO aprovada exige classificacao; classificacao em motivo != OUTRO → 400', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const gestor = await loginDe(ctx.app, 'gestor.teste');

    const jOutro = await justificar(ctx, exec, 'OUTRO', 'vazamento de óleo hidráulico na moega');
    const semClass = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/justificativas/${jOutro}/decisao`,
      headers: { cookie: gestor },
      payload: { decisao: 'APROVADA' },
    });
    expect(semClass.statusCode).toBe(400);

    const comClass = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/justificativas/${jOutro}/decisao`,
      headers: { cookie: gestor },
      payload: { decisao: 'APROVADA', classificacao: 'INTERNA' },
    });
    expect(comClass.statusCode).toBe(200);
    expect((comClass.json() as JustificativaResumo).classificacao).toBe('INTERNA');

    // motivo != OUTRO com classificacao no payload → 400
    const jChuva = await justificar(ctx, exec, 'CHUVA');
    const erro = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/justificativas/${jChuva}/decisao`,
      headers: { cookie: gestor },
      payload: { decisao: 'APROVADA', classificacao: 'EXTERNA' },
    });
    expect(erro.statusCode).toBe(400);
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('OUTRO reprovada grava classificacao NULL; 404 e 409 e 403', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    const vist = await loginDe(ctx.app, 'vistoriador.teste');

    // 404
    expect(
      (await ctx.app.inject({ method: 'PATCH', url: '/api/justificativas/9999/decisao', headers: { cookie: gestor }, payload: { decisao: 'APROVADA' } })).statusCode,
    ).toBe(404);

    const jid = await justificar(ctx, exec, 'OUTRO', 'motivo desconhecido a apurar');
    // 403 executante
    expect(
      (await ctx.app.inject({ method: 'PATCH', url: `/api/justificativas/${jid}/decisao`, headers: { cookie: exec }, payload: { decisao: 'REPROVADA' } })).statusCode,
    ).toBe(403);
    expect(
      (await ctx.app.inject({ method: 'PATCH', url: `/api/justificativas/${jid}/decisao`, headers: { cookie: vist }, payload: { decisao: 'REPROVADA' } })).statusCode,
    ).toBe(403);

    const rep = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/justificativas/${jid}/decisao`,
      headers: { cookie: gestor },
      payload: { decisao: 'REPROVADA' },
    });
    expect(rep.statusCode).toBe(200);
    expect((rep.json() as JustificativaResumo).classificacao).toBeNull(); // reprovada = null

    // 2ª decisão → 409
    expect(
      (await ctx.app.inject({ method: 'PATCH', url: `/api/justificativas/${jid}/decisao`, headers: { cookie: gestor }, payload: { decisao: 'APROVADA' } })).statusCode,
    ).toBe(409);
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('fila lista PENDENTE com contexto; Pareto conta por motivo', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    await justificar(ctx, exec, 'CHUVA');
    await justificar(ctx, exec, 'NAVIO_OPERANDO');

    const fila = (
      await ctx.app.inject({ method: 'GET', url: '/api/justificativas?status=PENDENTE', headers: { cookie: gestor } })
    ).json() as JustificativaFilaItem[];
    expect(fila.length).toBe(2);
    expect(fila[0]!.areaNome).toBeTruthy();
    expect(fila[0]!.atividade).toBeTruthy();

    const pareto = (
      await ctx.app.inject({ method: 'GET', url: '/api/justificativas/pareto?dias=30', headers: { cookie: gestor } })
    ).json() as { total: number; pareto: Array<{ motivo: string; total: number }> };
    expect(pareto.total).toBe(2);
    expect(pareto.pareto.find((p) => p.motivo === 'CHUVA')!.total).toBe(1);
    expect(pareto.pareto.find((p) => p.motivo === 'NAVIO_OPERANDO')!.total).toBe(1);

    // executante não acessa a fila
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/justificativas', headers: { cookie: exec } })).statusCode,
    ).toBe(403);
    await ctx.app.close();
    ctx.sqlite.close();
  });
});

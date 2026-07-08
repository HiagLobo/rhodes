import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { dataRecife, somarDias, type InstanciaResumo } from '@rhodes/shared';

import { buildApp } from '../src/app.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { seedDev, SENHA_DEV } from '../src/db/seed.js';
import { resetRateLimit } from '../src/lib/auth.js';
import { dailyJob } from '../src/services/scheduler/daily-job.js';
import { onComplete } from '../src/services/scheduler/on-complete.js';

async function novoApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-vistoria-'));
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

/** Conclui pelo MOTOR (evidência não é o assunto desta suíte) e devolve o id. */
function concluidaPor(ctx: Ctx, login: string, filtroIntervalo = '= 1'): number {
  const u = ctx.sqlite.prepare('SELECT id FROM users WHERE login = ?').get(login) as {
    id: number;
  };
  const row = ctx.sqlite
    .prepare(
      `SELECT ti.id FROM task_instances ti JOIN task_templates tt ON tt.id = ti.template_id
       WHERE ti.status = 'PENDING' AND tt.interval_days ${filtroIntervalo}
         AND tt.trigger_type != 'SHIP_EVENT' ORDER BY ti.id LIMIT 1`,
    )
    .get() as { id: number };
  onComplete(ctx.db, row.id, { id: u.id, login }, new Date());
  return row.id;
}

type ItemFila = {
  id: number;
  areaNome: string;
  executanteLogin: string | null;
  finishedAt: string | null;
  amostral: boolean;
};

async function fila(ctx: Ctx, cookie: string, query = ''): Promise<ItemFila[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/vistoria/fila${query}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as ItemFila[];
}

beforeEach(() => {
  resetRateLimit();
});

describe('fila de vistoria', () => {
  it('lista concluídas sem inspeção por antiguidade; EXECUTANTE não acessa (403)', async () => {
    const ctx = await novoApp();
    const vist = await loginDe(ctx.app, 'vistoriador.teste');
    const exec = await loginDe(ctx.app, 'executante.teste');

    const a = concluidaPor(ctx, 'executante.teste', '= 1');
    const b = concluidaPor(ctx, 'executante.teste', '>= 7');
    // b terminou "antes" (forja a antiguidade — timestamps do seed são do mesmo segundo)
    ctx.sqlite
      .prepare('UPDATE task_instances SET finished_at = finished_at - 3600 WHERE id = ?')
      .run(b);

    const itens = await fila(ctx, vist);
    expect(itens.length).toBe(2);
    expect(itens[0]!.id).toBe(b); // mais antiga primeiro
    expect(itens[1]!.id).toBe(a);
    expect(itens[0]!.executanteLogin).toBe('executante.teste');

    expect(
      (
        await ctx.app.inject({ method: 'GET', url: '/api/vistoria/fila', headers: { cookie: exec } })
      ).statusCode,
    ).toBe(403);
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('filtra por área', async () => {
    const ctx = await novoApp();
    const vist = await loginDe(ctx.app, 'vistoriador.teste');
    const id = concluidaPor(ctx, 'executante.teste');
    const area = ctx.sqlite
      .prepare(
        `SELECT tt.area_id AS areaId FROM task_instances ti
         JOIN task_templates tt ON tt.id = ti.template_id WHERE ti.id = ?`,
      )
      .get(id) as { areaId: number };

    expect((await fila(ctx, vist, `?areaId=${area.areaId}`)).length).toBe(1);
    expect((await fila(ctx, vist, '?areaId=9999')).length).toBe(0);
    await ctx.app.close();
    ctx.sqlite.close();
  });
});

describe('assinatura por senha', () => {
  it('senha errada → 401; 5 falhas → 429; senha certa → aprova, audita e sai da fila', async () => {
    const ctx = await novoApp();
    const vist = await loginDe(ctx.app, 'vistoriador.teste');
    const id = concluidaPor(ctx, 'executante.teste');

    for (let i = 0; i < 5; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/instancias/${id}/aprovar`,
        headers: { cookie: vist },
        payload: { senha: 'senha-errada' },
      });
      expect(res.statusCode).toBe(401);
    }
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/api/instancias/${id}/aprovar`,
          headers: { cookie: vist },
          payload: { senha: SENHA_DEV },
        })
      ).statusCode,
    ).toBe(429); // bloqueado mesmo com a senha certa

    resetRateLimit();
    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/api/instancias/${id}/aprovar`,
      headers: { cookie: vist },
      payload: { senha: SENHA_DEV },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { resultado: string }).resultado).toBe('APROVADA');

    expect((await fila(ctx, vist)).length).toBe(0);
    const auditoria = ctx.sqlite
      .prepare("SELECT criado_em FROM audit_log WHERE acao = 'EXECUCAO_APROVADA'")
      .get() as { criado_em: number };
    expect(auditoria.criado_em).toBeGreaterThan(0); // timestamp do servidor
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('segregação no endpoint: gestor que executou não aprova a própria execução', async () => {
    const ctx = await novoApp();
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    const id = concluidaPor(ctx, 'gestor.teste');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/instancias/${id}/aprovar`,
      headers: { cookie: gestor },
      payload: { senha: SENHA_DEV },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { erro: string }).erro).toContain('executou');
    await ctx.app.close();
    ctx.sqlite.close();
  });
});

describe('reprovação', () => {
  it('cria retrabalho que aparece na AGORA com o prazo; detalhe expõe a inspeção', async () => {
    const ctx = await novoApp();
    const vist = await loginDe(ctx.app, 'vistoriador.teste');
    const exec = await loginDe(ctx.app, 'executante.teste');
    const id = concluidaPor(ctx, 'executante.teste', '>= 7');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/instancias/${id}/reprovar`,
      headers: { cookie: vist },
      payload: { senha: SENHA_DEV, motivo: 'MOFO', severidade: 'CRITICA' },
    });
    expect(res.statusCode).toBe(200);
    const corpo = res.json() as { retrabalhoInstanceId: number; retrabalhoDue: string };
    expect(corpo.retrabalhoDue).toBe(somarDias(dataRecife(new Date()), 1));

    const agora = (
      await ctx.app.inject({ method: 'GET', url: '/api/agora', headers: { cookie: exec } })
    ).json() as InstanciaResumo[];
    expect(
      agora.some((i) => i.id === corpo.retrabalhoInstanceId && i.dueDate === corpo.retrabalhoDue),
    ).toBe(true);

    const detalhe = (
      await ctx.app.inject({ method: 'GET', url: `/api/instancias/${id}`, headers: { cookie: exec } })
    ).json() as { inspecao: { resultado: string; motivo: string; retrabalhoDue: string } };
    expect(detalhe.inspecao).toMatchObject({
      resultado: 'REPROVADA',
      motivo: 'MOFO',
      retrabalhoDue: corpo.retrabalhoDue,
    });
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('dependência física: dependente invisível na AGORA até APROVAR a predecessora do round', async () => {
    const ctx = await novoApp();
    const vist = await loginDe(ctx.app, 'vistoriador.teste');
    const exec = await loginDe(ctx.app, 'executante.teste');
    const execId = (
      ctx.sqlite.prepare("SELECT id FROM users WHERE login = 'executante.teste'").get() as {
        id: number;
      }
    ).id;

    // templates sintéticos A (predecessora) e B (dependente de A), rodada 42
    const areaId = (ctx.sqlite.prepare('SELECT id FROM areas LIMIT 1').get() as { id: number }).id;
    const criarTemplate = ctx.sqlite.prepare(
      `INSERT INTO task_templates (area_id, atividade, frequency, interval_days, schedule_mode,
         grace_days, trigger_type, depends_on_template_id, ativo)
       VALUES (?, ?, 'QUINZENAL', 15, 'FLOATING', 1, 'HYBRID', ?, 1)`,
    );
    const tA = criarTemplate.run(areaId, 'Sintética A (limpa primeiro)', null)
      .lastInsertRowid as number;
    const tB = criarTemplate.run(areaId, 'Sintética B (depende de A)', tA)
      .lastInsertRowid as number;
    const hoje = dataRecife(new Date());
    const criarInst = ctx.sqlite.prepare(
      `INSERT INTO task_instances (template_id, due_date, window_end, status, origin, round_id, executante_id, finished_at)
       VALUES (?, ?, ?, ?, 'SHIP', 42, ?, ?)`,
    );
    const iA = criarInst.run(tA, hoje, hoje, 'DONE_ON_TIME', execId, Math.floor(Date.now() / 1000))
      .lastInsertRowid as number;
    const iB = criarInst.run(tB, hoje, hoje, 'PENDING', null, null).lastInsertRowid as number;

    const antes = (
      await ctx.app.inject({ method: 'GET', url: '/api/agora', headers: { cookie: exec } })
    ).json() as InstanciaResumo[];
    expect(antes.some((i) => i.id === iB)).toBe(false); // gate fechado

    // REPROVAR a predecessora NÃO libera
    await ctx.app.inject({
      method: 'POST',
      url: `/api/instancias/${iA}/reprovar`,
      headers: { cookie: vist },
      payload: { senha: SENHA_DEV, motivo: 'MOFO', severidade: 'MENOR' },
    });
    const aposReprovar = (
      await ctx.app.inject({ method: 'GET', url: '/api/agora', headers: { cookie: exec } })
    ).json() as InstanciaResumo[];
    expect(aposReprovar.some((i) => i.id === iB)).toBe(false);

    // nova execução de A no MESMO round, desta vez APROVADA → libera B
    const iA2 = criarInst.run(
      tA,
      hoje,
      hoje,
      'DONE_ON_TIME',
      execId,
      Math.floor(Date.now() / 1000),
    ).lastInsertRowid as number;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/instancias/${iA2}/aprovar`,
      headers: { cookie: vist },
      payload: { senha: SENHA_DEV },
    });
    const depois = (
      await ctx.app.inject({ method: 'GET', url: '/api/agora', headers: { cookie: exec } })
    ).json() as InstanciaResumo[];
    expect(depois.some((i) => i.id === iB)).toBe(true);

    // dependente SEM round (calendário) nunca é segurada
    ctx.sqlite.prepare('UPDATE task_instances SET status = ? WHERE id = ?').run('MISSED', iB); // libera o índice
    const iC = ctx.sqlite
      .prepare(
        `INSERT INTO task_instances (template_id, due_date, window_end, status, origin)
         VALUES (?, ?, ?, 'PENDING', 'CALENDAR')`,
      )
      .run(tB, hoje, hoje).lastInsertRowid as number;
    const semRound = (
      await ctx.app.inject({ method: 'GET', url: '/api/agora', headers: { cookie: exec } })
    ).json() as InstanciaResumo[];
    expect(semRound.some((i) => i.id === iC)).toBe(true);
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('OUTRO sem texto → 400; foto de outra instância → 400', async () => {
    const ctx = await novoApp();
    const vist = await loginDe(ctx.app, 'vistoriador.teste');
    const id = concluidaPor(ctx, 'executante.teste');

    const semTexto = await ctx.app.inject({
      method: 'POST',
      url: `/api/instancias/${id}/reprovar`,
      headers: { cookie: vist },
      payload: { senha: SENHA_DEV, motivo: 'OUTRO', severidade: 'MENOR' },
    });
    expect(semTexto.statusCode).toBe(400);

    const comFotoAlheia = await ctx.app.inject({
      method: 'POST',
      url: `/api/instancias/${id}/reprovar`,
      headers: { cookie: vist },
      payload: { senha: SENHA_DEV, motivo: 'MOFO', severidade: 'MENOR', fotoId: 9999 },
    });
    expect(comFotoAlheia.statusCode).toBe(400);
    await ctx.app.close();
    ctx.sqlite.close();
  });
});

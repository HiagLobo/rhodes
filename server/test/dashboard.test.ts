import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { dataRecife, grupoDaArea, somarDias, type DashboardPayload, type Notificacoes } from '@rhodes/shared';

import { buildApp } from '../src/app.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { seedDev, SENHA_DEV } from '../src/db/seed.js';
import { resetRateLimit } from '../src/lib/auth.js';
import { dailyJob } from '../src/services/scheduler/daily-job.js';
import { onComplete } from '../src/services/scheduler/on-complete.js';

async function novoApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-dash-'));
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

async function dash(ctx: Ctx, cookie: string): Promise<DashboardPayload> {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as DashboardPayload;
}

beforeEach(() => {
  resetRateLimit();
});

describe('grupoDaArea — tabela dourada das 34 áreas reais do seed', () => {
  it('classifica cada área no grupo certo, nenhuma em Outras', () => {
    const esperado: Record<string, string> = {
      'Moega de Recebimento (superior)': 'Moegas',
      'Moega de Recebimento (inferior)': 'Moegas',
      'Cinta Transportadora (T5)': 'Cintas',
      'Cinta Transportadora (T6)': 'Cintas',
      'Cinta Transportadora (T7)': 'Cintas',
      'Cinta Transportadora (TRMT4)': 'Cintas',
      'Redler da moega': 'Redlers',
      'Redlers de expedição': 'Redlers',
      'Elevador de recebimento (1B)': 'Elevadores',
      'Elevadores das máquinas': 'Elevadores',
      'Elevadores de expedição': 'Elevadores',
      'Máquina de Pré Limpeza': 'MPL',
      'Prédio Máquina de Limpeza (Filtros de Manga)': 'Máquina de Limpeza',
      'Prédio da Máquina de limpeza (paredes)': 'Máquina de Limpeza',
      'Prédio da Máquina de limpeza (piso)': 'Máquina de Limpeza',
      'Prédio da Máquina de limpeza (tubulações)': 'Máquina de Limpeza',
      'Silos de Pó': 'Silos de Pó',
      'Túnel Recebimento': 'Túneis',
      'Túnel TRMT08A (bateria silo 1 ao 4)': 'Túneis',
      'Túnel TRMT08A (bateria silo 5 ao 8)': 'Túneis',
      'Área de expedição de subproduto': 'Expedição',
      'Área expedição de malte': 'Expedição',
      'Área externa - acesso ao terminal (portões)': 'Externas',
      'Área externa - caçambas (entulho)': 'Externas',
      'Área externa dos silos': 'Externas',
      'Área externa predial (ADM e Máquina de Limpeza)': 'Externas', // NÃO Máquina de Limpeza
    };
    for (let n = 1; n <= 8; n++) esperado[`Silo ${n}`] = 'Silos';

    for (const [area, grupo] of Object.entries(esperado)) {
      expect(grupoDaArea(area), area).toBe(grupo);
    }
    expect(Object.keys(esperado).length).toBe(34);
  });
});

describe('GET /api/dashboard', () => {
  it('sem cookie → 401; qualquer papel logado lê', async () => {
    const ctx = await novoApp();
    expect((await ctx.app.inject({ method: 'GET', url: '/api/dashboard' })).statusCode).toBe(401);
    const exec = await loginDe(ctx.app, 'executante.teste');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie: exec } })).statusCode).toBe(200);
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('cartões e grade batem com o seed; carência conta em Hoje/atenção (não em Atrasadas)', async () => {
    const ctx = await novoApp();
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    const hoje = dataRecife(new Date());

    // 1 OVERDUE forjada (janela no passado)
    const overdue = ctx.sqlite.prepare("SELECT id, template_id FROM task_instances LIMIT 1").get() as { id: number; template_id: number };
    ctx.sqlite
      .prepare("UPDATE task_instances SET status='OVERDUE', due_date='2026-01-01', window_end='2026-01-02' WHERE id = ?")
      .run(overdue.id);

    // 1 em CARÊNCIA: due ontem, janela amanhã, status PENDING (o dailyJob NÃO a marcou OVERDUE)
    const carencia = ctx.sqlite
      .prepare("SELECT id FROM task_instances WHERE id != ? LIMIT 1")
      .get(overdue.id) as { id: number };
    ctx.sqlite
      .prepare('UPDATE task_instances SET status=?, due_date=?, window_end=? WHERE id=?')
      .run('PENDING', somarDias(hoje, -1), somarDias(hoje, 1), carencia.id);

    const d = await dash(ctx, gestor);
    expect(d.cartoes.atrasadas).toBe(1); // só a OVERDUE
    expect(d.cartoes.hoje).toBeGreaterThanOrEqual(1); // a carência entra em Hoje
    // score30d agora é calculado (Onda 08): number quando há cobertura, ou null; nunca undefined
    expect(d.cartoes.score30d === null || typeof d.cartoes.score30d === 'number').toBe(true);

    // a carência caiu num grupo com situação ATENÇÃO (HOJE), não bom
    const grupoCarencia = grupoDaArea(
      (ctx.sqlite.prepare(
        `SELECT a.nome FROM task_instances ti JOIN task_templates t ON t.id=ti.template_id JOIN areas a ON a.id=t.area_id WHERE ti.id=?`,
      ).get(carencia.id) as { nome: string }).nome,
    );
    const cellCarencia = d.grade.find((g) => g.grupo === grupoCarencia)!;
    expect(['OVERDUE', 'HOJE']).toContain(cellCarencia.situacao); // nunca FUTURA/NENHUMA
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('grade muda de banda após concluir de verdade (ciclo dinâmico do ONDA)', async () => {
    const ctx = await novoApp();
    const gestor = await loginDe(ctx.app, 'gestor.teste');

    // pega um grupo com exatamente 1 área/1 template aberto para isolar a mudança
    const alvo = ctx.sqlite
      .prepare(
        `SELECT ti.id, a.nome AS area FROM task_instances ti
         JOIN task_templates t ON t.id=ti.template_id JOIN areas a ON a.id=t.area_id
         WHERE ti.status='PENDING' AND a.nome LIKE 'Silo %' LIMIT 1`,
      )
      .get() as { id: number; area: string };
    const grupo = grupoDaArea(alvo.area);

    const antes = (await dash(ctx, gestor)).grade.find((g) => g.grupo === grupo)!;
    expect(antes.abertas).toBeGreaterThan(0);

    // conclui TODAS as abertas dos Silos → o grupo some da grade (sem abertas)
    const abertasSilo = ctx.sqlite
      .prepare(
        `SELECT ti.id FROM task_instances ti JOIN task_templates t ON t.id=ti.template_id
         JOIN areas a ON a.id=t.area_id WHERE ti.status='PENDING' AND a.nome LIKE 'Silo %'`,
      )
      .all() as { id: number }[];
    const exec = ctx.sqlite.prepare("SELECT id FROM users WHERE login='executante.teste'").get() as { id: number };
    for (const inst of abertasSilo) {
      // planta evidência mínima direto? não — o motor onComplete não exige foto; a validação é na rota.
      onComplete(ctx.db, inst.id, { id: exec.id, login: 'executante.teste' }, new Date());
    }
    // onComplete gera a próxima (calendário) — para provar mudança, forço a próxima para o futuro
    ctx.sqlite
      .prepare(
        `UPDATE task_instances SET due_date='2099-01-01', window_end='2099-01-05'
         WHERE template_id IN (SELECT t.id FROM task_templates t JOIN areas a ON a.id=t.area_id WHERE a.nome LIKE 'Silo %')
           AND status='PENDING'`,
      )
      .run();

    const depois = (await dash(ctx, gestor)).grade.find((g) => g.grupo === grupo);
    // ou sumiu (sem abertas hoje) ou virou FUTURA (bom) — em ambos, deixou de ser o estado inicial
    expect(depois?.situacao ?? 'NENHUMA').not.toBe('OVERDUE');
    if (depois) expect(depois.situacao).toBe('FUTURA');
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('rodada ativa reflete a operação mais recente não-DESATRACADO', async () => {
    const ctx = await novoApp();
    const gestor = await loginDe(ctx.app, 'gestor.teste');

    // sem navio → rodada null
    expect((await dash(ctx, gestor)).rodada).toBeNull();

    await ctx.app.inject({
      method: 'POST',
      url: '/api/navios',
      headers: { cookie: gestor },
      payload: { navio: 'MV Antiga', etaDate: '2026-07-20' },
    });
    const nova = await ctx.app.inject({
      method: 'POST',
      url: '/api/navios',
      headers: { cookie: gestor },
      payload: { navio: 'MV Recente', etaDate: '2026-07-25' },
    });
    expect(nova.statusCode).toBe(201);

    const d = await dash(ctx, gestor);
    expect(d.rodada?.navio).toBe('MV Recente'); // a mais recente (maior id)
    expect(d.rodada?.status).toBe('ANUNCIADO');
    await ctx.app.close();
    ctx.sqlite.close();
  });
});

async function notif(ctx: Ctx, cookie: string): Promise<Notificacoes> {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/notificacoes', headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as Notificacoes;
}

describe('GET /api/notificacoes', () => {
  it('pool: OVERDUE nunca iniciada (executanteId NULL) aparece para o executante', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');

    const alvo = ctx.sqlite.prepare('SELECT id FROM task_instances LIMIT 1').get() as { id: number };
    // OVERDUE sem dono (executante_id NULL — o caso central do negócio)
    ctx.sqlite
      .prepare("UPDATE task_instances SET status='OVERDUE', due_date='2026-01-01', window_end='2026-01-02', executante_id=NULL WHERE id=?")
      .run(alvo.id);

    const n = await notif(ctx, exec);
    expect(n.overdue).toBeGreaterThanOrEqual(1); // vê a atrasada mesmo sem dono
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('escalonação = filtro de data: windowEnd=ontem NÃO escalona; anteontem SIM', async () => {
    const ctx = await novoApp();
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    const hoje = dataRecife(new Date());

    const ids = ctx.sqlite.prepare('SELECT id FROM task_instances LIMIT 2').all() as { id: number }[];
    // OVERDUE com janela vencida ONTEM → atrasada mas NÃO escalonada
    ctx.sqlite
      .prepare("UPDATE task_instances SET status='OVERDUE', due_date=?, window_end=? WHERE id=?")
      .run(somarDias(hoje, -3), somarDias(hoje, -1), ids[0]!.id);
    let n = await notif(ctx, gestor);
    const overdueAntes = n.overdue;
    expect(n.escalonadas).toBe(0);

    // segunda OVERDUE com janela vencida ANTEONTEM → escalonada
    ctx.sqlite
      .prepare("UPDATE task_instances SET status='OVERDUE', due_date=?, window_end=? WHERE id=?")
      .run(somarDias(hoje, -5), somarDias(hoje, -2), ids[1]!.id);
    n = await notif(ctx, gestor);
    expect(n.overdue).toBe(overdueAntes + 1);
    expect(n.escalonadas).toBe(1);
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('decisão de justificativa criada pelo executante aparece em 48h; papéis recebem campos certos', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const gestor = await loginDe(ctx.app, 'gestor.teste');

    // executante justifica; gestor decide
    const agora = (
      await ctx.app.inject({ method: 'GET', url: '/api/agora', headers: { cookie: exec } })
    ).json() as { id: number }[];
    const jid = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/instancias/${agora[0]!.id}/justificar`,
        headers: { cookie: exec },
        payload: { motivo: 'CHUVA' },
      })
    ).json() as { justificativaId: number };

    // gestor vê pendente ANTES de decidir
    expect((await notif(ctx, gestor)).justificativasPendentes).toBeGreaterThanOrEqual(1);

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/justificativas/${jid.justificativaId}/decisao`,
      headers: { cookie: gestor },
      payload: { decisao: 'APROVADA' },
    });

    const nExec = await notif(ctx, exec);
    expect(nExec.decisoes).toBe(1); // executante que criou vê a decisão
    expect(nExec.justificativasPendentes).toBe(0); // campo de gestor zerado para executante

    const nGestor = await notif(ctx, gestor);
    expect(nGestor.justificativasPendentes).toBe(0); // decidida
    expect(nGestor.decisoes).toBe(0); // campo de executante zerado para gestor

    // vistoriador vê a fila, não as justificativas
    const vist = await loginDe(ctx.app, 'vistoriador.teste');
    const nVist = await notif(ctx, vist);
    expect(nVist.filaVistoria).toBeGreaterThanOrEqual(0);
    expect(nVist.justificativasPendentes).toBe(0);
    await ctx.app.close();
    ctx.sqlite.close();
  });
});

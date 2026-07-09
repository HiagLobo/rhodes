import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { dataRecife, somarDias, type DossieDados, type ScoreResultado } from '@rhodes/shared';

import { buildApp } from '../src/app.js';
import { gerarCsvInstancias } from '../src/services/report/csv.js';
import { createDb, runMigrations, type Db } from '../src/db/index.js';
import { photos } from '../src/db/schema.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { seedDev, SENHA_DEV } from '../src/db/seed.js';
import { resetRateLimit } from '../src/lib/auth.js';
import { montarDossieDados } from '../src/services/report/montar-dados.js';
import { dailyJob } from '../src/services/scheduler/daily-job.js';

import type DatabaseType from 'better-sqlite3';

type Ctx = { app: ReturnType<typeof buildApp>; db: Db; sqlite: DatabaseType.Database; dir: string };

async function novoApp(): Promise<Ctx> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-rel-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  await seedDev(db);
  seedCatalogo(db);
  dailyJob(db, new Date());
  return { app: buildApp({ db, sqlite, dataDir: dir }), db, sqlite, dir };
}

async function fechar(ctx: Ctx): Promise<void> {
  await ctx.app.close();
  ctx.sqlite.close();
}

function extrairCookie(setCookie: string | string[] | undefined): string {
  if (setCookie === undefined) return '';
  const linha = Array.isArray(setCookie) ? setCookie[0]! : setCookie;
  return linha.split(';')[0]!;
}

async function login(app: Ctx['app'], login: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { login, senha: SENHA_DEV } });
  return extrairCookie(res.headers['set-cookie']);
}

function loginDoPapel(sqlite: DatabaseType.Database, role: string): string {
  return (sqlite.prepare('SELECT login FROM users WHERE role=? AND ativo=1 LIMIT 1').get(role) as { login: string }).login;
}

async function inserirFoto(ctx: Ctx): Promise<void> {
  const inst = ctx.sqlite.prepare('SELECT id FROM task_instances LIMIT 1').get() as { id: number };
  const enviador = (ctx.sqlite.prepare('SELECT id FROM users LIMIT 1').get() as { id: number }).id;
  const rel = path.posix.join('fotos', '2026', '07', 'testsha.jpg');
  fs.mkdirSync(path.join(ctx.dir, 'fotos', '2026', '07'), { recursive: true });
  const jpeg = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#557799' } }).jpeg().toBuffer();
  fs.writeFileSync(path.join(ctx.dir, rel), jpeg);
  ctx.db
    .insert(photos)
    .values({
      instanceId: inst.id,
      tipo: 'ANTES',
      parte: 1,
      sha256: 'testsha',
      path: rel,
      tamanhoBytes: jpeg.length,
      capturedAt: new Date(),
      skewMs: 0,
      enviadoPorId: enviador,
    })
    .run();
}

beforeEach(() => {
  resetRateLimit();
});

describe('rotas de relatório (GESTOR)', () => {
  it('só GESTOR acessa dossie/csv/historico (403 para os demais)', async () => {
    const ctx = await novoApp();
    const hoje = dataRecife(new Date());
    const qs = `inicio=${somarDias(hoje, -30)}&fim=${hoje}`;
    const exec = await login(ctx.app, loginDoPapel(ctx.sqlite, 'EXECUTANTE'));
    const vist = await login(ctx.app, loginDoPapel(ctx.sqlite, 'VISTORIADOR'));
    for (const rota of [`/api/relatorios/dossie?${qs}`, `/api/relatorios/csv?${qs}`, '/api/relatorios/historico']) {
      expect((await ctx.app.inject({ method: 'GET', url: rota, headers: { cookie: exec } })).statusCode).toBe(403);
      expect((await ctx.app.inject({ method: 'GET', url: rota, headers: { cookie: vist } })).statusCode).toBe(403);
    }
    await fechar(ctx);
  });

  it('GET /dossie → application/pdf com content-disposition e corpo %PDF (embutindo foto real)', async () => {
    const ctx = await novoApp();
    const hoje = dataRecife(new Date());
    ctx.sqlite.prepare('UPDATE task_instances SET due_date=?, window_end=?').run(hoje, hoje);
    await inserirFoto(ctx);
    const gestor = await login(ctx.app, 'gestor.teste');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/relatorios/dossie?inicio=${somarDias(hoje, -1)}&fim=${hoje}`,
      headers: { cookie: gestor },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/pdf');
    expect(String(res.headers['content-disposition'])).toContain('dossie-');
    expect(res.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    await fechar(ctx);
  });

  it('GET /csv → UTF-8 com BOM e 1:1 com as instâncias do período', async () => {
    const ctx = await novoApp();
    const hoje = dataRecife(new Date());
    ctx.sqlite.prepare('UPDATE task_instances SET due_date=?, window_end=?').run(hoje, hoje);
    const gestor = await login(ctx.app, 'gestor.teste');
    const filtros = { inicio: somarDias(hoje, -1), fim: hoje, somenteReprovadasOuCriticas: false };
    const esperado = montarDossieDados(ctx.db, filtros, new Date()).paginas.length;
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/relatorios/csv?inicio=${filtros.inicio}&fim=${filtros.fim}`,
      headers: { cookie: gestor },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/csv');
    const body = res.rawPayload.toString('utf8');
    expect(body.charCodeAt(0)).toBe(0xfeff); // BOM
    const linhas = body.replace(/\r\n$/, '').split('\r\n');
    expect(esperado).toBeGreaterThan(0);
    expect(linhas.length - 1).toBe(esperado); // menos o cabeçalho
    await fechar(ctx);
  });

  it('filtros inválidos → 400; período válido com =false → 200', async () => {
    const ctx = await novoApp();
    const hoje = dataRecife(new Date());
    const gestor = await login(ctx.app, 'gestor.teste');
    const g = (url: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie: gestor } });
    expect((await g(`/api/relatorios/csv?inicio=${hoje}&fim=${somarDias(hoje, -5)}`)).statusCode).toBe(400); // fim<inicio
    expect((await g('/api/relatorios/csv?inicio=2026-01-01&fim=2026-12-31')).statusCode).toBe(400); // > 186 dias
    expect((await g(`/api/relatorios/csv?inicio=${somarDias(hoje, -1)}&fim=${hoje}&somenteReprovadasOuCriticas=false`)).statusCode).toBe(200);
    await fechar(ctx);
  });

  it('cada geração grava RELATORIO_GERADO e aparece no /historico', async () => {
    const ctx = await novoApp();
    const hoje = dataRecife(new Date());
    ctx.sqlite.prepare('UPDATE task_instances SET due_date=?, window_end=?').run(hoje, hoje);
    const gestor = await login(ctx.app, 'gestor.teste');
    await ctx.app.inject({
      method: 'GET',
      url: `/api/relatorios/csv?inicio=${somarDias(hoje, -1)}&fim=${hoje}`,
      headers: { cookie: gestor },
    });
    const linhas = ctx.sqlite.prepare("SELECT depois FROM audit_log WHERE acao='RELATORIO_GERADO'").all() as {
      depois: string;
    }[];
    expect(linhas.length).toBe(1);
    const d = JSON.parse(linhas[0]!.depois) as { formato: string; hash: string; nInstancias: number };
    expect(d.formato).toBe('CSV');
    expect(typeof d.hash).toBe('string');
    expect(typeof d.nInstancias).toBe('number');

    const hist = (
      await ctx.app.inject({ method: 'GET', url: '/api/relatorios/historico', headers: { cookie: gestor } })
    ).json() as { formato: string; hash: string; nInstancias: number }[];
    expect(hist.length).toBe(1);
    expect(hist[0]!.formato).toBe('CSV');
    expect(hist[0]!.hash).toBe(d.hash);
    await fechar(ctx);
  });
});

describe('gerarCsvInstancias — anti-injeção de fórmula', () => {
  const score: ScoreResultado = {
    score: 80,
    banda: 'ATENCAO',
    componentes: {
      pontualidade: { valor: 0.8, n: 1 },
      aprovacao: { valor: 1, n: 1 },
      cobertura: { valor: 1, n: 1 },
    },
    demeritos: 0,
    n: 1,
    incertezaMais: 0,
    incertezaMenos: 0,
    taxaJustificadas: 0,
    areas: [],
  };

  function dossieComNavio(navio: string): DossieDados {
    return {
      periodo: { inicio: '2026-06-01', fim: '2026-06-30' },
      geradoEm: '2026-07-09T12:00:00.000Z',
      responsaveis: [],
      areas: [{ id: 1, nome: 'Moega', peso: 1 }],
      score,
      coberturaSnapshot: false,
      conformidade: [],
      paginas: [
        {
          instanceId: 1,
          areaId: 1,
          areaNome: 'Moega',
          atividade: 'Limpar',
          frequency: 'DIARIA',
          intervalDays: 1,
          dueDate: '2026-06-10',
          windowEnd: '2026-06-10',
          statusFinal: 'DONE_ON_TIME',
          conformidade: 'NO_PRAZO',
          executante: 'exec.a',
          finishedAt: '2026-06-10T10:00:00.000Z',
          tempoExecucaoSeg: 600,
          metodoVersao: null,
          fotos: [],
          inspecao: null,
          navioLote: { roundId: 1, navio, produto: 'MILHO', tonelagem: 100, etaDate: '2026-06-09' },
        },
      ],
      justificativas: [],
      hash: 'x',
    };
  }

  it('neutraliza célula de texto iniciada por = (Excel não executa como fórmula)', () => {
    const csv = gerarCsvInstancias(dossieComNavio('=HYPERLINK("http://evil",A1)'));
    const linha = csv.split('\r\n')[1]!;
    expect(csv).toContain(`'=HYPERLINK`); // prefixada com apóstrofo
    // nenhuma célula da linha de dados começa com '=' (nem no início, nem após ';' ou aspas)
    expect(linha).not.toMatch(/(^|;|")=/);
  });

  it('não polui colunas numéricas nem texto comum', () => {
    const csv = gerarCsvInstancias(dossieComNavio('MV BOA VIAGEM'));
    const linha = csv.split('\r\n')[1]!;
    expect(linha).toContain('MV BOA VIAGEM'); // sem apóstrofo
    expect(linha).toContain(';10;'); // tempo (min) = 600/60 = 10, numérico cru
  });
});

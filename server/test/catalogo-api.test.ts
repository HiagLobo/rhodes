import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import type { Procedimento, ProcedimentoDetalhe } from '@rhodes/shared';

import { buildApp } from '../src/app.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { seedDev, SENHA_DEV } from '../src/db/seed.js';
import { resetRateLimit } from '../src/lib/auth.js';

async function novoApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-cat-api-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  await seedDev(db);
  seedCatalogo(db);
  return { app: buildApp({ db, sqlite }), db, sqlite };
}

function extrairCookie(setCookie: string | string[] | undefined): string {
  if (setCookie === undefined) return '';
  const linha = Array.isArray(setCookie) ? setCookie[0]! : setCookie;
  return linha.split(';')[0]!;
}

async function loginDe(app: Awaited<ReturnType<typeof novoApp>>['app'], login: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login, senha: SENHA_DEV },
  });
  return extrairCookie(res.headers['set-cookie']);
}

beforeEach(() => {
  resetRateLimit();
});

describe('leitura do catálogo (qualquer logado)', () => {
  it('sem cookie → 401; executante lê 34 áreas e 39 procedimentos com método atual', async () => {
    const { app, sqlite } = await novoApp();
    expect((await app.inject({ method: 'GET', url: '/api/areas' })).statusCode).toBe(401);

    const cookie = await loginDe(app, 'executante.teste');
    const areasRes = await app.inject({ method: 'GET', url: '/api/areas', headers: { cookie } });
    expect(areasRes.statusCode).toBe(200);
    expect((areasRes.json() as unknown[]).length).toBe(34);

    const procs = await app.inject({ method: 'GET', url: '/api/procedimentos', headers: { cookie } });
    const lista = procs.json() as Procedimento[];
    expect(lista.length).toBe(39);
    expect(lista.every((p) => p.metodoAtual !== null && p.metodoAtual.versao === 1)).toBe(true);
    await app.close();
    sqlite.close();
  });

  it('escrita como EXECUTANTE → 403 em todas as rotas de mutação', async () => {
    const { app, sqlite } = await novoApp();
    const cookie = await loginDe(app, 'executante.teste');
    const casos: Array<[string, string]> = [
      ['POST', '/api/areas'],
      ['PATCH', '/api/areas/1'],
      ['POST', '/api/procedimentos'],
      ['PATCH', '/api/procedimentos/1'],
      ['POST', '/api/procedimentos/1/metodo'],
      ['POST', '/api/procedimentos/1/desativar'],
      ['POST', '/api/procedimentos/1/reativar'],
    ];
    for (const [method, url] of casos) {
      const res = await app.inject({
        method: method as 'POST' | 'PATCH',
        url,
        headers: { cookie },
        payload: {},
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    await app.close();
    sqlite.close();
  });
});

describe('criação de procedimento (gestor)', () => {
  it('cria com defaults derivados (QUINZENAL → FLOATING, intervalo 14, tolerância 1) e audita', async () => {
    const { app, sqlite } = await novoApp();
    const cookie = await loginDe(app, 'gestor.teste');
    const res = await app.inject({
      method: 'POST',
      url: '/api/procedimentos',
      headers: { cookie },
      payload: {
        areaId: 1,
        atividade: 'Limpeza extra de teste da moega',
        frequency: 'QUINZENAL',
        metodo: 'Método de teste versão um.',
      },
    });
    expect(res.statusCode).toBe(201);
    const p = res.json() as Procedimento;
    expect(p.scheduleMode).toBe('FLOATING');
    expect(p.intervalDays).toBe(14);
    expect(p.graceDays).toBe(1);
    expect(p.triggerType).toBe('CALENDAR');
    expect(p.metodoAtual?.versao).toBe(1);
    expect(p.metodoAtual?.criadoPor).toBe('gestor.teste');

    const auditoria = sqlite
      .prepare("SELECT ator_login FROM audit_log WHERE acao = 'PROCEDIMENTO_CRIADO'")
      .get() as { ator_login: string };
    expect(auditoria.ator_login).toBe('gestor.teste');
    await app.close();
    sqlite.close();
  });

  it('HYBRID sem shipPhase → 400; área inexistente → 404', async () => {
    const { app, sqlite } = await novoApp();
    const cookie = await loginDe(app, 'gestor.teste');
    const semFase = await app.inject({
      method: 'POST',
      url: '/api/procedimentos',
      headers: { cookie },
      payload: {
        areaId: 1,
        atividade: 'X',
        frequency: 'QUINZENAL',
        triggerType: 'HYBRID',
        metodo: 'm',
      },
    });
    expect(semFase.statusCode).toBe(400);
    const areaRuim = await app.inject({
      method: 'POST',
      url: '/api/procedimentos',
      headers: { cookie },
      payload: { areaId: 9999, atividade: 'X', frequency: 'DIARIO', metodo: 'm' },
    });
    expect(areaRuim.statusCode).toBe(404);
    await app.close();
    sqlite.close();
  });
});

describe('edição de procedimento (gestor)', () => {
  it('mudar frequência re-deriva intervalo/tolerância/modo e audita antes/depois', async () => {
    const { app, sqlite } = await novoApp();
    const cookie = await loginDe(app, 'gestor.teste');
    const lista = (
      await app.inject({ method: 'GET', url: '/api/procedimentos', headers: { cookie } })
    ).json() as Procedimento[];
    const quinzenal = lista.find((p) => p.frequency === 'QUINZENAL' && p.triggerType === 'CALENDAR')!;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/procedimentos/${quinzenal.id}`,
      headers: { cookie },
      payload: { frequency: 'MENSAL' },
    });
    expect(res.statusCode).toBe(200);
    const p = res.json() as Procedimento;
    expect(p.intervalDays).toBe(30);
    expect(p.graceDays).toBe(3);
    expect(p.scheduleMode).toBe('FLOATING');

    const auditoria = sqlite
      .prepare("SELECT antes, depois FROM audit_log WHERE acao = 'PROCEDIMENTO_EDITADO'")
      .get() as { antes: string; depois: string };
    expect(JSON.parse(auditoria.antes)).toMatchObject({ frequency: 'QUINZENAL', intervalDays: 14 });
    expect(JSON.parse(auditoria.depois)).toMatchObject({ frequency: 'MENSAL', intervalDays: 30 });
    await app.close();
    sqlite.close();
  });

  it('trigger final CALENDAR zera shipPhase/leadDays; final HYBRID sem fase → 400', async () => {
    const { app, sqlite } = await novoApp();
    const cookie = await loginDe(app, 'gestor.teste');
    const lista = (
      await app.inject({ method: 'GET', url: '/api/procedimentos', headers: { cookie } })
    ).json() as Procedimento[];
    const hibrida = lista.find((p) => p.triggerType === 'HYBRID')!;
    const pura = lista.find((p) => p.triggerType === 'CALENDAR')!;

    const paraCalendar = await app.inject({
      method: 'PATCH',
      url: `/api/procedimentos/${hibrida.id}`,
      headers: { cookie },
      payload: { triggerType: 'CALENDAR' },
    });
    const p = paraCalendar.json() as Procedimento;
    expect(p.shipPhase).toBeNull();
    expect(p.leadDays).toBeNull();

    const paraHibrida = await app.inject({
      method: 'PATCH',
      url: `/api/procedimentos/${pura.id}`,
      headers: { cookie },
      payload: { triggerType: 'HYBRID' },
    });
    expect(paraHibrida.statusCode).toBe(400);
    await app.close();
    sqlite.close();
  });
});

describe('versionamento de método (gestor)', () => {
  it('nova versão vira atual, preserva a v1 byte a byte, incrementa e audita', async () => {
    const { app, sqlite } = await novoApp();
    const cookie = await loginDe(app, 'gestor.teste');
    const lista = (
      await app.inject({ method: 'GET', url: '/api/procedimentos', headers: { cookie } })
    ).json() as Procedimento[];
    const alvo = lista[0]!;
    const textoV1 = alvo.metodoAtual!.texto;

    const res = await app.inject({
      method: 'POST',
      url: `/api/procedimentos/${alvo.id}/metodo`,
      headers: { cookie },
      payload: { texto: 'Método revisado pelo gestor — versão dois.' },
    });
    expect(res.statusCode).toBe(201);

    const detalhe = (
      await app.inject({ method: 'GET', url: `/api/procedimentos/${alvo.id}`, headers: { cookie } })
    ).json() as ProcedimentoDetalhe;
    expect(detalhe.metodoAtual?.versao).toBe(2);
    expect(detalhe.historico.map((v) => v.versao)).toEqual([2, 1]);
    expect(detalhe.historico[1]!.texto).toBe(textoV1);

    const { n } = sqlite
      .prepare("SELECT COUNT(*) as n FROM audit_log WHERE acao = 'METODO_NOVA_VERSAO'")
      .get() as { n: number };
    expect(n).toBe(1);
    await app.close();
    sqlite.close();
  });
});

describe('peso de área e desativação (gestor)', () => {
  it('PATCH peso audita antes/depois; id inexistente → 404', async () => {
    const { app, sqlite } = await novoApp();
    const cookie = await loginDe(app, 'gestor.teste');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/areas/1',
      headers: { cookie },
      payload: { pesoCriticidade: 2.0 },
    });
    expect(res.statusCode).toBe(200);
    const auditoria = sqlite
      .prepare("SELECT antes, depois FROM audit_log WHERE acao = 'AREA_PESO_ALTERADO'")
      .get() as { antes: string; depois: string };
    expect(JSON.parse(auditoria.depois)).toMatchObject({ pesoCriticidade: 2.0 });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/areas/9999',
          headers: { cookie },
          payload: { pesoCriticidade: 1.5 },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
    sqlite.close();
  });

  it('desativar some da listagem default; ?inativos=1 mostra; reativar volta', async () => {
    const { app, sqlite } = await novoApp();
    const cookie = await loginDe(app, 'gestor.teste');
    await app.inject({ method: 'POST', url: '/api/procedimentos/1/desativar', headers: { cookie } });

    const ativos = (
      await app.inject({ method: 'GET', url: '/api/procedimentos', headers: { cookie } })
    ).json() as Procedimento[];
    expect(ativos.length).toBe(38);
    const todos = (
      await app.inject({ method: 'GET', url: '/api/procedimentos?inativos=1', headers: { cookie } })
    ).json() as Procedimento[];
    expect(todos.length).toBe(39);

    await app.inject({ method: 'POST', url: '/api/procedimentos/1/reativar', headers: { cookie } });
    const dnovo = (
      await app.inject({ method: 'GET', url: '/api/procedimentos', headers: { cookie } })
    ).json() as Procedimento[];
    expect(dnovo.length).toBe(39);
    await app.close();
    sqlite.close();
  });

  it('área duplicada → 409', async () => {
    const { app, sqlite } = await novoApp();
    const cookie = await loginDe(app, 'gestor.teste');
    const res = await app.inject({
      method: 'POST',
      url: '/api/areas',
      headers: { cookie },
      payload: { nome: 'Silo 01' },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
    sqlite.close();
  });
});

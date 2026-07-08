import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import type { InstanciaResumo, OperacaoNavio, RodadaResumo } from '@rhodes/shared';

import { buildApp } from '../src/app.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { seedDev, SENHA_DEV } from '../src/db/seed.js';
import { resetRateLimit } from '../src/lib/auth.js';
import { dailyJob } from '../src/services/scheduler/daily-job.js';

async function novoApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-navios-api-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  await seedDev(db);
  seedCatalogo(db);
  dailyJob(db, new Date()); // 39 abertas de calendário
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

/** eventAt válido: agora (≥ evento anterior, nunca futuro) — o anúncio é sempre "agora". */
function eventAtValido(): string {
  return new Date().toISOString();
}

async function anunciar(app: Awaited<ReturnType<typeof novoApp>>['app'], cookie: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/navios',
    headers: { cookie },
    payload: { navio: 'MV Cevada Star', produto: 'Cevada', etaDate: '2026-07-20' },
  });
  return res.json() as OperacaoNavio;
}

beforeEach(() => {
  resetRateLimit();
});

describe('registro e confirmação', () => {
  it('executante anuncia (evento NÃO confirmado); gestor confirma; 2ª confirmação → 409', async () => {
    const { app, sqlite } = await novoApp();
    const exec = await loginDe(app, 'executante.teste');
    const gestor = await loginDe(app, 'gestor.teste');

    const op = await anunciar(app, exec);
    expect(op.status).toBe('ANUNCIADO');
    expect(op.eventos[0]!.confirmado).toBe(false);
    expect(op.eventos[0]!.registradoPor).toBe('executante.teste');

    const conf = await app.inject({
      method: 'POST',
      url: `/api/navios/eventos/${op.eventos[0]!.id}/confirmar`,
      headers: { cookie: gestor },
    });
    expect(conf.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/navios/eventos/${op.eventos[0]!.id}/confirmar`,
          headers: { cookie: gestor },
        })
      ).statusCode,
    ).toBe(409);
    await app.close();
    sqlite.close();
  });

  it('vistoriador lê (200) mas não registra (403)', async () => {
    const { app, sqlite } = await novoApp();
    const vist = await loginDe(app, 'vistoriador.teste');
    expect(
      (await app.inject({ method: 'GET', url: '/api/navios', headers: { cookie: vist } }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/navios',
          headers: { cookie: vist },
          payload: { navio: 'X', etaDate: '2026-07-20' },
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
    sqlite.close();
  });
});

describe('transições e validação de eventAt', () => {
  it('pular etapa → 409; eventAt no futuro → 400; anterior ao último evento → 400', async () => {
    const { app, sqlite } = await novoApp();
    const gestor = await loginDe(app, 'gestor.teste');
    const op = await anunciar(app, gestor);

    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/navios/${op.id}/transicao`,
          headers: { cookie: gestor },
          payload: { para: 'DESCARGA_CONCLUIDA', eventAt: eventAtValido() },
        })
      ).statusCode,
    ).toBe(409);

    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/navios/${op.id}/transicao`,
          headers: { cookie: gestor },
          payload: { para: 'ATRACADO', eventAt: new Date(Date.now() + 3600_000).toISOString() },
        })
      ).statusCode,
    ).toBe(400);

    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/navios/${op.id}/transicao`,
          headers: { cookie: gestor },
          payload: { para: 'ATRACADO', eventAt: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() },
        })
      ).statusCode,
    ).toBe(400); // antes do evento ANUNCIADO
    await app.close();
    sqlite.close();
  });

  it('fluxo completo: descarga concluída dispara a rodada com as 9 híbridas do seed', async () => {
    const { app, sqlite } = await novoApp();
    const gestor = await loginDe(app, 'gestor.teste');
    const exec = await loginDe(app, 'executante.teste');
    const op = await anunciar(app, gestor);

    for (const para of ['ATRACADO', 'DESCARGA_INICIADA', 'DESCARGA_CONCLUIDA'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/navios/${op.id}/transicao`,
        headers: { cookie: gestor },
        payload: { para, eventAt: eventAtValido() },
      });
      expect(res.statusCode, para).toBe(200);
    }

    const rodada = (
      await app.inject({ method: 'GET', url: `/api/navios/${op.id}/rodada`, headers: { cookie: gestor } })
    ).json() as { resumo: RodadaResumo; itens: Array<{ id: number }> };
    expect(rodada.resumo).toEqual({ total: 9, concluidas: 0 });

    // concluir uma da rodada atualiza o resumo
    await app.inject({
      method: 'POST',
      url: `/api/instancias/${rodada.itens[0]!.id}/concluir`,
      headers: { cookie: exec },
    });
    const depois = (
      await app.inject({ method: 'GET', url: `/api/navios/${op.id}/rodada`, headers: { cookie: gestor } })
    ).json() as { resumo: RodadaResumo };
    expect(depois.resumo).toEqual({ total: 9, concluidas: 1 });

    // as antecipadas aparecem na AGORA com origem SHIP
    const agora = (
      await app.inject({ method: 'GET', url: '/api/agora', headers: { cookie: gestor } })
    ).json() as InstanciaResumo[];
    expect(agora.filter((i) => i.origin === 'SHIP').length).toBe(8); // 9 − 1 concluída
    await app.close();
    sqlite.close();
  });

  it('ETA remarcado: 200 antes de atracar (audita), 409 depois', async () => {
    const { app, sqlite } = await novoApp();
    const gestor = await loginDe(app, 'gestor.teste');
    const op = await anunciar(app, gestor);

    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/navios/${op.id}/eta`,
          headers: { cookie: gestor },
          payload: { etaDate: '2026-07-25' },
        })
      ).statusCode,
    ).toBe(200);
    const auditoria = sqlite
      .prepare("SELECT depois FROM audit_log WHERE acao = 'NAVIO_ETA_ALTERADA'")
      .get() as { depois: string };
    expect(JSON.parse(auditoria.depois)).toMatchObject({ etaDate: '2026-07-25' });

    await app.inject({
      method: 'POST',
      url: `/api/navios/${op.id}/transicao`,
      headers: { cookie: gestor },
      payload: { para: 'ATRACADO', eventAt: eventAtValido() },
    });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/navios/${op.id}/eta`,
          headers: { cookie: gestor },
          payload: { etaDate: '2026-07-26' },
        })
      ).statusCode,
    ).toBe(409);
    await app.close();
    sqlite.close();
  });
});

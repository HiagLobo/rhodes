import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import type { InstanciaDetalhe, InstanciaResumo } from '@rhodes/shared';

import { buildApp } from '../src/app.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { seedDev, SENHA_DEV } from '../src/db/seed.js';
import { resetRateLimit } from '../src/lib/auth.js';
import { dailyJob } from '../src/services/scheduler/daily-job.js';
import {
  EvidenciaInvalidaError,
  tempoPorPartes,
  validarEvidencia,
} from '../src/services/scheduler/validar-evidencia.js';
import { plantarEvidencia } from './helpers/evidencia.js';

async function novoApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-conclusao-'));
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

async function iniciada(ctx: Ctx, cookie: string, indice = 0): Promise<number> {
  const agora = (
    await ctx.app.inject({ method: 'GET', url: '/api/agora', headers: { cookie } })
  ).json() as InstanciaResumo[];
  const id = agora[indice]!.id;
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/instancias/${id}/iniciar`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return id;
}

async function concluir(ctx: Ctx, cookie: string, id: number) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/instancias/${id}/concluir`,
    headers: { cookie },
  });
}

beforeEach(() => {
  resetRateLimit();
});

describe('validarEvidencia (pura)', () => {
  const foto = (tipo: string, parte: number, minuto: number) => ({
    tipo,
    parte,
    receivedAt: new Date(Date.UTC(2026, 6, 8, 10, minuto)),
  });

  it('exige ANTES e DEPOIS da parte e o intervalo mínimo; devolve o tempo', () => {
    expect(() => validarEvidencia([], 1, 5)).toThrow(EvidenciaInvalidaError);
    expect(() => validarEvidencia([foto('ANTES', 1, 0)], 1, 5)).toThrow(/DEPOIS/);
    expect(() =>
      validarEvidencia([foto('ANTES', 1, 0), foto('DEPOIS', 1, 2)], 1, 5),
    ).toThrow(/5 min/);
    // fotos de OUTRA parte não contam
    expect(() =>
      validarEvidencia([foto('ANTES', 1, 0), foto('DEPOIS', 1, 30)], 2, 5),
    ).toThrow(/ANTES/);
    expect(validarEvidencia([foto('ANTES', 1, 0), foto('DEPOIS', 1, 30)], 1, 5).tempoSeg).toBe(
      1800,
    );
  });

  it('tempoPorPartes soma só partes com par completo', () => {
    expect(tempoPorPartes([foto('ANTES', 1, 0)])).toBeNull();
    expect(
      tempoPorPartes([
        foto('ANTES', 1, 0),
        foto('DEPOIS', 1, 10),
        foto('ANTES', 2, 20),
        foto('DEPOIS', 2, 50),
        foto('ANTES', 3, 55), // parte 3 sem DEPOIS: fora da soma
      ]),
    ).toBe(600 + 1800);
  });
});

describe('conclusão real (backend manda)', () => {
  it('sem foto → 409 ANTES; só ANTES → 409 DEPOIS; par no mesmo minuto → 409 intervalo', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const id = await iniciada(ctx, exec);

    let res = await concluir(ctx, exec, id);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { erro: string }).erro).toContain('ANTES');

    // só ANTES (plantado direto — o upload tem suíte própria)
    const user = ctx.sqlite
      .prepare("SELECT id FROM users WHERE login = 'executante.teste'")
      .get() as { id: number };
    const agora = Math.floor(Date.now() / 1000);
    ctx.sqlite
      .prepare(
        `INSERT INTO photos (instance_id, tipo, parte, sha256, path, tamanho_bytes,
           captured_at, received_at, skew_ms, enviado_por_id)
         VALUES (?, 'ANTES', 1, 'so-antes', 'fotos/t/a.jpg', 100, ?, ?, 0, ?)`,
      )
      .run(id, agora, agora, user.id);
    res = await concluir(ctx, exec, id);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { erro: string }).erro).toContain('DEPOIS');

    // DEPOIS no mesmo instante → intervalo < 5 min
    ctx.sqlite
      .prepare(
        `INSERT INTO photos (instance_id, tipo, parte, sha256, path, tamanho_bytes,
           captured_at, received_at, skew_ms, enviado_por_id)
         VALUES (?, 'DEPOIS', 1, 'mesmo-minuto', 'fotos/t/b.jpg', 100, ?, ?, 0, ?)`,
      )
      .run(id, agora, agora, user.id);
    res = await concluir(ctx, exec, id);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { erro: string }).erro).toContain('min');
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('com evidência válida conclui, gera a próxima e mede o tempo; detalhe expõe tudo', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const id = await iniciada(ctx, exec);

    plantarEvidencia(ctx.sqlite, id, 'executante.teste', { minutos: 10 });
    const res = await concluir(ctx, exec, id);
    expect(res.statusCode).toBe(200);
    const corpo = res.json() as {
      statusFinal: string;
      proximaDue: string | null;
      tempoExecucaoSeg: number;
    };
    expect(corpo.statusFinal).toBe('DONE_ON_TIME');
    expect(corpo.proximaDue).not.toBeNull();
    expect(corpo.tempoExecucaoSeg).toBe(600);

    const detalhe = (
      await ctx.app.inject({ method: 'GET', url: `/api/instancias/${id}`, headers: { cookie: exec } })
    ).json() as InstanciaDetalhe;
    expect(detalhe.status).toBe('DONE_ON_TIME');
    expect(detalhe.tempoExecucaoSeg).toBe(600);
    expect(detalhe.metodo).toBeTruthy(); // versão vigente do seed (Onda 02)
    expect(detalhe.fotos.length).toBe(2);
    expect(detalhe.fotos[0]).not.toHaveProperty('path');
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('multi-dia: parte com evidência própria; percentual precisa avançar; tempo total soma', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const gestor = await loginDe(ctx.app, 'gestor.teste');
    const id = await iniciada(ctx, exec);

    // parte sem evidência → 409
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/api/instancias/${id}/partes`,
          headers: { cookie: exec },
          payload: { percentualAcumulado: 40 },
        })
      ).statusCode,
    ).toBe(409);

    plantarEvidencia(ctx.sqlite, id, 'executante.teste', { minutos: 10, parte: 1 });

    // outro usuário (mesmo gestor) não registra parte de quem iniciou → 403
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/api/instancias/${id}/partes`,
          headers: { cookie: gestor },
          payload: { percentualAcumulado: 40 },
        })
      ).statusCode,
    ).toBe(403);

    const p1 = await ctx.app.inject({
      method: 'POST',
      url: `/api/instancias/${id}/partes`,
      headers: { cookie: exec },
      payload: { percentualAcumulado: 40, observacao: 'metade da parede norte' },
    });
    expect(p1.statusCode).toBe(201);
    expect(p1.json()).toMatchObject({ parte: 1, percentualAcumulado: 40, tempoSegParte: 600 });

    // percentual não avança → 400 (antes de olhar evidência)
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/api/instancias/${id}/partes`,
          headers: { cookie: exec },
          payload: { percentualAcumulado: 40 },
        })
      ).statusCode,
    ).toBe(400);

    // segue IN_PROGRESS; parte corrente virou 2 e ainda não tem fotos → concluir 409
    expect((await concluir(ctx, exec, id)).statusCode).toBe(409);

    plantarEvidencia(ctx.sqlite, id, 'executante.teste', { minutos: 20, parte: 2 });
    const fim = await concluir(ctx, exec, id);
    expect(fim.statusCode).toBe(200);
    expect((fim.json() as { tempoExecucaoSeg: number }).tempoExecucaoSeg).toBe(600 + 1200);

    const detalhe = (
      await ctx.app.inject({ method: 'GET', url: `/api/instancias/${id}`, headers: { cookie: exec } })
    ).json() as InstanciaDetalhe;
    expect(detalhe.partes.length).toBe(1);
    expect(detalhe.partes[0]).toMatchObject({ parte: 1, percentualAcumulado: 40 });
    expect(detalhe.tempoExecucaoSeg).toBe(1800);

    const auditoria = ctx.sqlite
      .prepare("SELECT depois FROM audit_log WHERE acao = 'PARTE_REGISTRADA'")
      .get() as { depois: string };
    expect(JSON.parse(auditoria.depois)).toMatchObject({ parte: 1, percentualAcumulado: 40 });
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('upload de foto respeita a parte corrente (integra com o pipeline da S1)', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const id = await iniciada(ctx, exec);

    plantarEvidencia(ctx.sqlite, id, 'executante.teste', { minutos: 10, parte: 1 });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/instancias/${id}/partes`,
      headers: { cookie: exec },
      payload: { percentualAcumulado: 60 },
    });

    const detalhe = (
      await ctx.app.inject({ method: 'GET', url: `/api/instancias/${id}`, headers: { cookie: exec } })
    ).json() as InstanciaDetalhe;
    expect(detalhe.parteCorrente).toBe(2);
    await ctx.app.close();
    ctx.sqlite.close();
  });
});

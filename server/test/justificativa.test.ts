import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { dataRecife, somarDias, type InstanciaDetalhe, type InstanciaResumo } from '@rhodes/shared';

import { buildApp } from '../src/app.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { seedDev, SENHA_DEV } from '../src/db/seed.js';
import { resetRateLimit } from '../src/lib/auth.js';
import { dailyJob } from '../src/services/scheduler/daily-job.js';
import { onJustify } from '../src/services/scheduler/on-complete.js';

async function novoApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-justif-'));
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

async function alvoAberto(ctx: Ctx, cookie: string, indice = 0): Promise<InstanciaResumo> {
  const agora = (
    await ctx.app.inject({ method: 'GET', url: '/api/agora', headers: { cookie } })
  ).json() as InstanciaResumo[];
  return agora[indice]!;
}

async function justificar(ctx: Ctx, cookie: string, id: number, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/instancias/${id}/justificar`,
    headers: { cookie },
    payload,
  });
}

beforeEach(() => {
  resetRateLimit();
});

describe('justificativa estruturada', () => {
  it('NAVIO_OPERANDO: fecha MISSED, reagenda +1 dia, fica PENDENTE e audita', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const alvo = await alvoAberto(ctx, exec);

    const res = await justificar(ctx, exec, alvo.id, { motivo: 'NAVIO_OPERANDO' });
    expect(res.statusCode).toBe(200);
    const corpo = res.json() as { statusFinal: string; proximaDue: string; justificativaId: number };
    expect(corpo.statusFinal).toBe('MISSED');
    expect(corpo.proximaDue).toBe(somarDias(dataRecife(new Date()), 1));

    const detalhe = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/instancias/${alvo.id}`,
        headers: { cookie: exec },
      })
    ).json() as InstanciaDetalhe;
    expect(detalhe.status).toBe('MISSED');
    expect(detalhe.justificativa).toMatchObject({
      motivo: 'NAVIO_OPERANDO',
      status: 'PENDENTE',
      criadoPor: 'executante.teste',
    });

    // a próxima já está na fila (índice parcial liberado pelo MISSED)
    const lista = (
      await ctx.app.inject({ method: 'GET', url: '/api/agora', headers: { cookie: exec } })
    ).json() as InstanciaResumo[];
    expect(
      lista.some((i) => i.templateId === alvo.templateId && i.dueDate === corpo.proximaDue),
    ).toBe(true);

    const auditoria = ctx.sqlite
      .prepare("SELECT depois FROM audit_log WHERE acao = 'INSTANCIA_JUSTIFICADA'")
      .get() as { depois: string };
    expect(JSON.parse(auditoria.depois)).toMatchObject({
      status: 'MISSED',
      motivo: 'NAVIO_OPERANDO',
      proximaDue: corpo.proximaDue,
    });
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('AREA_INTERDITADA adia 2 dias; justificar de novo (fechada) → 409', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const alvo = await alvoAberto(ctx, exec);

    const res = await justificar(ctx, exec, alvo.id, { motivo: 'AREA_INTERDITADA' });
    expect((res.json() as { proximaDue: string }).proximaDue).toBe(
      somarDias(dataRecife(new Date()), 2),
    );

    expect((await justificar(ctx, exec, alvo.id, { motivo: 'CHUVA' })).statusCode).toBe(409);
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('OUTRO exige texto ≥10; vistoriador → 403', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const vist = await loginDe(ctx.app, 'vistoriador.teste');
    const alvo = await alvoAberto(ctx, exec);

    const sem = await justificar(ctx, exec, alvo.id, { motivo: 'OUTRO' });
    expect(sem.statusCode).toBe(400);
    expect((sem.json() as { erro: string }).erro).toContain('descrever');
    expect(
      (await justificar(ctx, exec, alvo.id, { motivo: 'OUTRO', texto: 'curto' })).statusCode,
    ).toBe(400);

    expect((await justificar(ctx, vist, alvo.id, { motivo: 'CHUVA' })).statusCode).toBe(403);

    expect(
      (
        await justificar(ctx, exec, alvo.id, {
          motivo: 'OUTRO',
          texto: 'vazamento de óleo hidráulico na área da moega',
        })
      ).statusCode,
    ).toBe(200);
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('foto de impedimento: aceita a da própria tarefa; rejeita de outra ou de outro tipo', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const alvo = await alvoAberto(ctx, exec, 0);
    const outra = await alvoAberto(ctx, exec, 1);

    const user = ctx.sqlite
      .prepare("SELECT id FROM users WHERE login = 'executante.teste'")
      .get() as { id: number };
    const agora = Math.floor(Date.now() / 1000);
    const inserir = ctx.sqlite.prepare(
      `INSERT INTO photos (instance_id, tipo, parte, sha256, path, tamanho_bytes,
         captured_at, received_at, skew_ms, enviado_por_id)
       VALUES (?, ?, 1, ?, 'fotos/t/x.jpg', 100, ?, ?, 0, ?)`,
    );
    const daOutra = inserir.run(outra.id, 'IMPEDIMENTO', 'imp-outra', agora, agora, user.id)
      .lastInsertRowid as number;
    const tipoErrado = inserir.run(alvo.id, 'ANTES', 'antes-alvo', agora, agora, user.id)
      .lastInsertRowid as number;
    const valida = inserir.run(alvo.id, 'IMPEDIMENTO', 'imp-alvo', agora, agora, user.id)
      .lastInsertRowid as number;

    for (const fotoId of [daOutra, tipoErrado]) {
      const res = await justificar(ctx, exec, alvo.id, {
        motivo: 'CHUVA',
        fotoImpedimentoId: fotoId,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { erro: string }).erro).toContain('impedimento');
    }

    const ok = await justificar(ctx, exec, alvo.id, { motivo: 'CHUVA', fotoImpedimentoId: valida });
    expect(ok.statusCode).toBe(200);

    const detalhe = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/instancias/${alvo.id}`,
        headers: { cookie: exec },
      })
    ).json() as InstanciaDetalhe;
    expect(detalhe.justificativa?.fotoId).toBe(valida);
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('rollback íntegro: ator fantasma → nada muda (nem MISSED, nem justificativa, nem próxima)', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const alvo = await alvoAberto(ctx, exec);

    // FK do audit_log estoura no fim da transação → tudo desfeito (fail-closed do audit())
    expect(() =>
      onJustify(
        ctx.db,
        alvo.id,
        { motivo: 'CHUVA' },
        { id: 9999, login: 'fantasma' },
        new Date(),
      ),
    ).toThrow();

    const inst = ctx.sqlite
      .prepare('SELECT status FROM task_instances WHERE id = ?')
      .get(alvo.id) as { status: string };
    expect(inst.status).toBe('PENDING');
    expect(
      (ctx.sqlite.prepare('SELECT count(*) AS n FROM justificativas').get() as { n: number }).n,
    ).toBe(0);
    await ctx.app.close();
    ctx.sqlite.close();
  });
});

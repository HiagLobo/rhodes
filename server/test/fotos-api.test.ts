import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { FOTO_MAX_BYTES, type FotoResumo, type InstanciaResumo } from '@rhodes/shared';

import { buildApp } from '../src/app.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { seedDev, SENHA_DEV } from '../src/db/seed.js';
import { resetRateLimit } from '../src/lib/auth.js';
import { dailyJob } from '../src/services/scheduler/daily-job.js';

/** JPEG 1×1 real — fixture mínima que passa no magic byte e no sharp. */
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

/** Variante bit-diferente (byte extra após o EOI — decodificadores toleram, hash muda). */
const JPEG_1X1_B = Buffer.concat([JPEG_1X1, Buffer.from([0x20])]);

async function novoApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-fotos-api-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  await seedDev(db);
  seedCatalogo(db);
  dailyJob(db, new Date());
  return { app: buildApp({ db, sqlite, dataDir: dir }), db, sqlite, dir };
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

/** Corpo multipart na mão (inject não monta FormData). Campos ANTES do arquivo — o
 *  @fastify/multipart só enxerga fields que chegaram antes do file no stream. */
function multipart(
  campos: Record<string, string>,
  binario: Buffer,
  contentType = 'image/jpeg',
): { payload: Buffer; headers: Record<string, string> } {
  const b = 'rhodesboundary42';
  const partes: Buffer[] = [];
  for (const [nome, valor] of Object.entries(campos)) {
    partes.push(
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${nome}"\r\n\r\n${valor}\r\n`),
    );
  }
  partes.push(
    Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="arquivo"; filename="foto.jpg"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
  );
  partes.push(binario, Buffer.from(`\r\n--${b}--\r\n`));
  return {
    payload: Buffer.concat(partes),
    headers: { 'content-type': `multipart/form-data; boundary=${b}` },
  };
}

function camposValidos(tipo = 'ANTES', deviceNow = new Date()): Record<string, string> {
  return {
    tipo,
    capturedAt: deviceNow.toISOString(),
    deviceNow: deviceNow.toISOString(),
    exifDatetime: '2026-07-08T09:15:00',
    exifModel: 'Samsung SM-A155M',
  };
}

type Ctx = Awaited<ReturnType<typeof novoApp>>;

async function primeiraInstancia(ctx: Ctx, cookie: string): Promise<number> {
  const agora = (
    await ctx.app.inject({ method: 'GET', url: '/api/agora', headers: { cookie } })
  ).json() as InstanciaResumo[];
  return agora[0]!.id;
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

beforeEach(() => {
  resetRateLimit();
});

describe('upload de evidência', () => {
  it('grava arquivo + linha com skew e EXIF do cliente; audita FOTO_RECEBIDA', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const id = await iniciada(ctx, exec);

    // relógio do aparelho 90 s atrasado → skew ≈ +90 000 ms
    const req = multipart(camposValidos('ANTES', new Date(Date.now() - 90_000)), JPEG_1X1);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/instancias/${id}/fotos`,
      headers: { cookie: exec, ...req.headers },
      payload: req.payload,
    });
    expect(res.statusCode).toBe(201);
    const foto = res.json() as FotoResumo;
    expect(foto.tipo).toBe('ANTES');
    expect(foto.parte).toBe(1);
    expect(foto.skewMs).toBeGreaterThan(80_000);
    expect(foto.skewMs).toBeLessThan(100_000);
    expect(foto.exifDatetime).toBe('2026-07-08T09:15:00');
    expect(foto.exifModel).toBe('Samsung SM-A155M');
    expect(foto).not.toHaveProperty('path'); // nunca vazar o filesystem

    const linha = ctx.sqlite
      .prepare('SELECT path, sha256 FROM photos WHERE id = ?')
      .get(foto.id) as { path: string; sha256: string };
    expect(fs.existsSync(path.join(ctx.dir, linha.path))).toBe(true);
    expect(linha.path).toContain(linha.sha256);

    const auditoria = ctx.sqlite
      .prepare("SELECT depois FROM audit_log WHERE acao = 'FOTO_RECEBIDA'")
      .get() as { depois: string };
    expect(JSON.parse(auditoria.depois)).toMatchObject({ tipo: 'ANTES', sha256: linha.sha256 });
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('mesma foto (mesmo hash) em OUTRA tarefa → 409', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const id1 = await iniciada(ctx, exec, 0);
    const id2 = await iniciada(ctx, exec, 1);

    const r1 = multipart(camposValidos(), JPEG_1X1);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/api/instancias/${id1}/fotos`,
          headers: { cookie: exec, ...r1.headers },
          payload: r1.payload,
        })
      ).statusCode,
    ).toBe(201);

    const r2 = multipart(camposValidos(), JPEG_1X1);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/instancias/${id2}/fotos`,
      headers: { cookie: exec, ...r2.headers },
      payload: r2.payload,
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { erro: string }).erro).toContain('já foi usada');
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('content-type não-JPEG → 415; acima de 10 MB → 413', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const id = await iniciada(ctx, exec);

    const png = multipart(camposValidos(), JPEG_1X1, 'image/png');
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/api/instancias/${id}/fotos`,
          headers: { cookie: exec, ...png.headers },
          payload: png.payload,
        })
      ).statusCode,
    ).toBe(415);

    const gigante = multipart(
      camposValidos(),
      Buffer.concat([JPEG_1X1, Buffer.alloc(FOTO_MAX_BYTES)]),
    );
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/api/instancias/${id}/fotos`,
          headers: { cookie: exec, ...gigante.headers },
          payload: gigante.payload,
        })
      ).statusCode,
    ).toBe(413);
    await ctx.app.close();
    ctx.sqlite.close();
  });

  it('ANTES sem iniciar → 409; iniciada por outro → 403; IMPEDIMENTO sem iniciar → 201', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const gestor = await loginDe(ctx.app, 'gestor.teste');

    const pendente = await primeiraInstancia(ctx, exec);
    const antes = multipart(camposValidos('ANTES'), JPEG_1X1);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/api/instancias/${pendente}/fotos`,
          headers: { cookie: exec, ...antes.headers },
          payload: antes.payload,
        })
      ).statusCode,
    ).toBe(409);

    const impedimento = multipart(camposValidos('IMPEDIMENTO'), JPEG_1X1);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/api/instancias/${pendente}/fotos`,
          headers: { cookie: exec, ...impedimento.headers },
          payload: impedimento.payload,
        })
      ).statusCode,
    ).toBe(201);

    const doGestor = await iniciada(ctx, gestor, 1);
    const intruso = multipart(camposValidos('ANTES'), JPEG_1X1_B);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/api/instancias/${doGestor}/fotos`,
          headers: { cookie: exec, ...intruso.headers },
          payload: intruso.payload,
        })
      ).statusCode,
    ).toBe(403);
    await ctx.app.close();
    ctx.sqlite.close();
  });
});

describe('servir evidência', () => {
  it('GET exige sessão (401); logado recebe image/jpeg; thumb cai para o original', async () => {
    const ctx = await novoApp();
    const exec = await loginDe(ctx.app, 'executante.teste');
    const id = await iniciada(ctx, exec);

    const up = multipart(camposValidos(), JPEG_1X1);
    const criada = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/instancias/${id}/fotos`,
        headers: { cookie: exec, ...up.headers },
        payload: up.payload,
      })
    ).json() as FotoResumo;

    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/fotos/${criada.id}/arquivo` })).statusCode,
    ).toBe(401);

    const ok = await ctx.app.inject({
      method: 'GET',
      url: `/api/fotos/${criada.id}/arquivo`,
      headers: { cookie: exec },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    // thumb: gerado pelo worker OU fallback para o original — sempre 200 image/jpeg
    const thumb = await ctx.app.inject({
      method: 'GET',
      url: `/api/fotos/${criada.id}/thumb`,
      headers: { cookie: exec },
    });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/jpeg');
    await ctx.app.close();
    ctx.sqlite.close();
  });
});

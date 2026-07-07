import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { createDb, runMigrations } from '../src/db/index.js';

describe('GET /api/health', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-health-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  const app = buildApp({ sqlite });

  afterAll(async () => {
    await app.close();
    sqlite.close();
  });

  it('responde 200 com db ok e a versão do pacote', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; db: string; version: string };
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('não expõe caminho do banco nem detalhes internos na resposta', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.body).not.toContain(dir);
    expect(res.body.toLowerCase()).not.toContain('rhodes-data');
    expect(res.body.toLowerCase()).not.toContain('.db');
  });

  it('responde 503 quando o banco está indisponível', async () => {
    const broken = createDb(fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-health2-')));
    broken.sqlite.close(); // simula banco fora do ar
    const appBroken = buildApp({ sqlite: broken.sqlite });
    const res = await appBroken.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { status: string; db: string };
    expect(body.db).toBe('erro');
    await appBroken.close();
  });
});

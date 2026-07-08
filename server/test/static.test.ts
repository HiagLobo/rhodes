import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { createDb, runMigrations } from '../src/db/index.js';

describe('serving estático de produção (fallback SPA)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-static-'));
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<html><body>rhodes spa</body></html>');

  const { db, sqlite } = createDb(dataDir);
  runMigrations(db);
  const app = buildApp({ db, sqlite, staticRoot: webRoot });

  afterAll(async () => {
    await app.close();
    sqlite.close();
  });

  it('serve o index.html na raiz', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('rhodes spa');
  });

  it('rota desconhecida da SPA cai no index.html (fallback)', async () => {
    const res = await app.inject({ method: 'GET', url: '/gestor/painel' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('rhodes spa');
  });

  it('/api inexistente responde 404 JSON — nunca index.html', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/rota-inexistente' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).not.toContain('rhodes spa');
  });

  it('a API continua funcionando com o estático ligado', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });

  it('sem staticRoot (dev/teste) nada é servido além da API', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-static2-'));
    const db2 = createDb(dir2);
    runMigrations(db2.db);
    const appDev = buildApp({ db: db2.db, sqlite: db2.sqlite });
    const res = await appDev.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    await appDev.close();
    db2.sqlite.close();
  });
});

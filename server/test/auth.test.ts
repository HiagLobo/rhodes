import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { seedDev, SENHA_DEV } from '../src/db/seed.js';
import { criarSessao, requireRole, resetRateLimit, revogarSessoesDoUsuario, validarSessao } from '../src/lib/auth.js';

async function novoApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-auth-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  await seedDev(db);
  const app = buildApp({ db, sqlite });
  // rota de exemplo protegida por papel — as rotas reais de GESTOR chegam na S4
  app.get('/api/teste-gestor', { preHandler: requireRole(db, 'GESTOR') }, () => ({ ok: true }));
  return { app, db, sqlite };
}

function extrairCookie(setCookie: string | string[] | undefined): string {
  const linha = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return linha.split(';')[0]!;
}

async function loginDe(app: Awaited<ReturnType<typeof novoApp>>['app'], login: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login, senha: SENHA_DEV },
  });
  return { res, cookie: extrairCookie(res.headers['set-cookie']) };
}

beforeEach(() => {
  resetRateLimit();
});

describe('POST /api/auth/login', () => {
  it('login ok: 200, cookie HttpOnly/SameSite, usuário público sem hash, LOGIN_OK auditado', async () => {
    const { app, sqlite } = await novoApp();
    const { res } = await loginDe(app, 'gestor.teste');
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('rhodes_sessao=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(res.body).not.toContain('password_hash');
    expect((res.json() as { role: string }).role).toBe('GESTOR');
    const auditoria = sqlite
      .prepare("SELECT ator_login FROM audit_log WHERE acao = 'LOGIN_OK'")
      .get() as { ator_login: string };
    expect(auditoria.ator_login).toBe('gestor.teste');
    await app.close();
    sqlite.close();
  });

  it('senha errada e login inexistente respondem IGUAIS (anti-enumeração) e auditam', async () => {
    const { app, sqlite } = await novoApp();
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'gestor.teste', senha: 'senha-errada-123' },
    });
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'nao.existe', senha: 'qualquer-coisa-1' },
    });
    expect(r1.statusCode).toBe(401);
    expect(r2.statusCode).toBe(401);
    expect(r1.body).toBe(r2.body);
    const { n } = sqlite
      .prepare("SELECT COUNT(*) as n FROM audit_log WHERE acao = 'LOGIN_FALHA'")
      .get() as { n: number };
    expect(n).toBe(2);
    await app.close();
    sqlite.close();
  });

  it('login de usuário desativado falha com a MESMA mensagem genérica', async () => {
    const { app, sqlite } = await novoApp();
    sqlite.prepare("UPDATE users SET ativo = 0 WHERE login = 'executante.teste'").run();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'executante.teste', senha: SENHA_DEV },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Login ou senha inválidos');
    await app.close();
    sqlite.close();
  });

  it('6ª tentativa em 15min é bloqueada com 429 e RATE_LIMIT auditado', async () => {
    const { app, sqlite } = await novoApp();
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { login: 'vistoriador.teste', senha: 'errada-de-proposito' },
      });
    }
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'vistoriador.teste', senha: SENHA_DEV },
    });
    expect(res.statusCode).toBe(429);
    const { n } = sqlite
      .prepare("SELECT COUNT(*) as n FROM audit_log WHERE acao = 'RATE_LIMIT'")
      .get() as { n: number };
    expect(n).toBe(1);
    await app.close();
    sqlite.close();
  });

  it('payload sem Zod válido → 400', async () => {
    const { app, sqlite } = await novoApp();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: '' } });
    expect(res.statusCode).toBe(400);
    await app.close();
    sqlite.close();
  });
});

describe('autorização (requireUser/requireRole)', () => {
  it('/api/auth/me sem cookie → 401; com cookie → usuário público', async () => {
    const { app, sqlite } = await novoApp();
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    const { cookie } = await loginDe(app, 'executante.teste');
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { login: string }).login).toBe('executante.teste');
    expect(res.body).not.toContain('password_hash');
    await app.close();
    sqlite.close();
  });

  it('EXECUTANTE em rota de GESTOR → 403; GESTOR → 200', async () => {
    const { app, sqlite } = await novoApp();
    const exec = await loginDe(app, 'executante.teste');
    const gestor = await loginDe(app, 'gestor.teste');
    expect(
      (await app.inject({ method: 'GET', url: '/api/teste-gestor', headers: { cookie: exec.cookie } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/teste-gestor',
          headers: { cookie: gestor.cookie },
        })
      ).statusCode,
    ).toBe(200);
    await app.close();
    sqlite.close();
  });

  it('sessão expirada → 401', async () => {
    const { app, sqlite } = await novoApp();
    const { cookie } = await loginDe(app, 'gestor.teste');
    sqlite.prepare('UPDATE sessions SET expira_em = 1000').run();
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(401);
    await app.close();
    sqlite.close();
  });

  it('expiração desliza: request autenticado renova expira_em', async () => {
    const { app, sqlite } = await novoApp();
    const { cookie } = await loginDe(app, 'gestor.teste');
    const daquiUmaHora = Math.floor(Date.now() / 1000) + 3600;
    sqlite.prepare('UPDATE sessions SET expira_em = ?').run(daquiUmaHora);
    await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    const { expira_em } = sqlite.prepare('SELECT expira_em FROM sessions').get() as {
      expira_em: number;
    };
    expect(expira_em).toBeGreaterThan(daquiUmaHora + 3600);
    await app.close();
    sqlite.close();
  });

  it('usuário desativado com sessão ativa → 401 no request seguinte', async () => {
    const { app, sqlite } = await novoApp();
    const { cookie } = await loginDe(app, 'executante.teste');
    sqlite.prepare("UPDATE users SET ativo = 0 WHERE login = 'executante.teste'").run();
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(401);
    await app.close();
    sqlite.close();
  });
});

describe('logout e revogação', () => {
  it('logout destrói a sessão, limpa o cookie e audita; /me volta 401', async () => {
    const { app, sqlite } = await novoApp();
    const { cookie } = await loginDe(app, 'gestor.teste');
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(
      401,
    );
    const { n } = sqlite
      .prepare("SELECT COUNT(*) as n FROM audit_log WHERE acao = 'LOGOUT'")
      .get() as { n: number };
    expect(n).toBe(1);
    await app.close();
    sqlite.close();
  });

  it('revogarSessoesDoUsuario derruba todas as sessões do usuário', async () => {
    const { db, sqlite } = await (async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-auth-rev-'));
      const { db, sqlite } = createDb(dir);
      runMigrations(db);
      await seedDev(db);
      return { db, sqlite };
    })();
    const gestor = sqlite.prepare("SELECT id FROM users WHERE login = 'gestor.teste'").get() as {
      id: number;
    };
    const s1 = criarSessao(db, gestor.id);
    const s2 = criarSessao(db, gestor.id);
    expect(validarSessao(db, s1.token)).not.toBeNull();
    revogarSessoesDoUsuario(db, gestor.id);
    expect(validarSessao(db, s1.token)).toBeNull();
    expect(validarSessao(db, s2.token)).toBeNull();
    sqlite.close();
  });

  it('token forjado/aleatório não valida', async () => {
    const { app, sqlite } = await novoApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'rhodes_sessao=token-forjado-qualquer' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
    sqlite.close();
  });
});

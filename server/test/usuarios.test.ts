import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { createDb, runMigrations } from '../src/db/index.js';
import { seedDev, SENHA_DEV } from '../src/db/seed.js';
import { resetRateLimit } from '../src/lib/auth.js';

const SENHA_NOVA = 'silo oito do porto';

async function novoApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-usuarios-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  await seedDev(db);
  return { app: buildApp({ db, sqlite }), db, sqlite };
}

function extrairCookie(setCookie: string | string[] | undefined): string {
  if (setCookie === undefined) return ''; // logins que falham não têm set-cookie
  const linha = Array.isArray(setCookie) ? setCookie[0]! : setCookie;
  return linha.split(';')[0]!;
}

async function loginDe(app: Awaited<ReturnType<typeof novoApp>>['app'], login: string, senha = SENHA_DEV) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { login, senha } });
  return { res, cookie: extrairCookie(res.headers['set-cookie']) };
}

beforeEach(() => {
  resetRateLimit();
});

describe('autorização de /api/usuarios', () => {
  it('sem cookie → 401; EXECUTANTE e VISTORIADOR → 403; GESTOR → 200', async () => {
    const { app, sqlite } = await novoApp();
    expect((await app.inject({ method: 'GET', url: '/api/usuarios' })).statusCode).toBe(401);
    for (const papel of ['executante.teste', 'vistoriador.teste']) {
      const { cookie } = await loginDe(app, papel);
      expect(
        (await app.inject({ method: 'GET', url: '/api/usuarios', headers: { cookie } })).statusCode,
      ).toBe(403);
    }
    const gestor = await loginDe(app, 'gestor.teste');
    const res = await app.inject({ method: 'GET', url: '/api/usuarios', headers: { cookie: gestor.cookie } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as unknown[]).length).toBe(3);
    expect(res.body).not.toContain('password_hash');
    await app.close();
    sqlite.close();
  });
});

describe('criar usuário', () => {
  it('gestor cria; novo usuário loga; USUARIO_CRIADO auditado com ator', async () => {
    const { app, sqlite } = await novoApp();
    const gestor = await loginDe(app, 'gestor.teste');
    const res = await app.inject({
      method: 'POST',
      url: '/api/usuarios',
      headers: { cookie: gestor.cookie },
      payload: { nome: 'Operador Novo', login: 'operador.novo', senha: SENHA_NOVA, role: 'EXECUTANTE' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('password_hash');

    const loginNovo = await loginDe(app, 'operador.novo', SENHA_NOVA);
    expect(loginNovo.res.statusCode).toBe(200);

    const auditoria = sqlite
      .prepare("SELECT ator_login, depois FROM audit_log WHERE acao = 'USUARIO_CRIADO'")
      .get() as { ator_login: string; depois: string };
    expect(auditoria.ator_login).toBe('gestor.teste');
    expect(auditoria.depois).toContain('operador.novo');
    expect(auditoria.depois).not.toContain(SENHA_NOVA);
    await app.close();
    sqlite.close();
  });

  it('senha da blocklist → 400 com problemas da política', async () => {
    const { app, sqlite } = await novoApp();
    const gestor = await loginDe(app, 'gestor.teste');
    const res = await app.inject({
      method: 'POST',
      url: '/api/usuarios',
      headers: { cookie: gestor.cookie },
      payload: { nome: 'X', login: 'x.teste', senha: '12345678', role: 'EXECUTANTE' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { problemas: string[] }).problemas.join(' ')).toMatch(/muito comum/);
    await app.close();
    sqlite.close();
  });

  it('login duplicado → 409', async () => {
    const { app, sqlite } = await novoApp();
    const gestor = await loginDe(app, 'gestor.teste');
    const res = await app.inject({
      method: 'POST',
      url: '/api/usuarios',
      headers: { cookie: gestor.cookie },
      payload: { nome: 'Duplicado', login: 'executante.teste', senha: SENHA_NOVA, role: 'EXECUTANTE' },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
    sqlite.close();
  });
});

describe('reset de senha', () => {
  it('troca a senha, derruba sessões antigas e audita sem vazar a senha', async () => {
    const { app, sqlite } = await novoApp();
    const gestor = await loginDe(app, 'gestor.teste');
    const exec = await loginDe(app, 'executante.teste');
    const idExec = (sqlite.prepare("SELECT id FROM users WHERE login = 'executante.teste'").get() as { id: number }).id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/usuarios/${idExec}/reset-senha`,
      headers: { cookie: gestor.cookie },
      payload: { senha: SENHA_NOVA },
    });
    expect(res.statusCode).toBe(200);

    // sessão antiga caiu
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: exec.cookie } })).statusCode,
    ).toBe(401);
    // senha antiga não vale; nova vale
    expect((await loginDe(app, 'executante.teste', SENHA_DEV)).res.statusCode).toBe(401);
    resetRateLimit();
    expect((await loginDe(app, 'executante.teste', SENHA_NOVA)).res.statusCode).toBe(200);

    const auditoria = sqlite
      .prepare("SELECT antes, depois FROM audit_log WHERE acao = 'SENHA_RESET'")
      .get() as { antes: string | null; depois: string | null };
    expect(String(auditoria.antes)).not.toContain(SENHA_NOVA);
    expect(String(auditoria.depois)).not.toContain(SENHA_NOVA);
    await app.close();
    sqlite.close();
  });
});

describe('desativar / reativar', () => {
  it('desativar derruba a sessão ativa no request seguinte e audita antes/depois', async () => {
    const { app, sqlite } = await novoApp();
    const gestor = await loginDe(app, 'gestor.teste');
    const exec = await loginDe(app, 'executante.teste');
    const idExec = (sqlite.prepare("SELECT id FROM users WHERE login = 'executante.teste'").get() as { id: number }).id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/usuarios/${idExec}/desativar`,
      headers: { cookie: gestor.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: exec.cookie } })).statusCode,
    ).toBe(401);

    const auditoria = sqlite
      .prepare("SELECT antes, depois FROM audit_log WHERE acao = 'USUARIO_DESATIVADO'")
      .get() as { antes: string; depois: string };
    expect(JSON.parse(auditoria.antes)).toMatchObject({ ativo: true });
    expect(JSON.parse(auditoria.depois)).toMatchObject({ ativo: false });
    await app.close();
    sqlite.close();
  });

  it('gestor não desativa a si mesmo → 400', async () => {
    const { app, sqlite } = await novoApp();
    const gestor = await loginDe(app, 'gestor.teste');
    const idGestor = (sqlite.prepare("SELECT id FROM users WHERE login = 'gestor.teste'").get() as { id: number }).id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/usuarios/${idGestor}/desativar`,
      headers: { cookie: gestor.cookie },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
    sqlite.close();
  });

  it('reativar devolve o acesso e audita', async () => {
    const { app, sqlite } = await novoApp();
    const gestor = await loginDe(app, 'gestor.teste');
    const idExec = (sqlite.prepare("SELECT id FROM users WHERE login = 'executante.teste'").get() as { id: number }).id;

    await app.inject({ method: 'POST', url: `/api/usuarios/${idExec}/desativar`, headers: { cookie: gestor.cookie } });
    expect((await loginDe(app, 'executante.teste')).res.statusCode).toBe(401);
    resetRateLimit();

    await app.inject({ method: 'POST', url: `/api/usuarios/${idExec}/reativar`, headers: { cookie: gestor.cookie } });
    expect((await loginDe(app, 'executante.teste')).res.statusCode).toBe(200);

    const { n } = sqlite
      .prepare("SELECT COUNT(*) as n FROM audit_log WHERE acao = 'USUARIO_REATIVADO'")
      .get() as { n: number };
    expect(n).toBe(1);
    await app.close();
    sqlite.close();
  });

  it('id inexistente → 404; id inválido → 400', async () => {
    const { app, sqlite } = await novoApp();
    const gestor = await loginDe(app, 'gestor.teste');
    expect(
      (await app.inject({ method: 'POST', url: '/api/usuarios/9999/desativar', headers: { cookie: gestor.cookie } }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/api/usuarios/abc/desativar', headers: { cookie: gestor.cookie } }))
        .statusCode,
    ).toBe(400);
    await app.close();
    sqlite.close();
  });
});

import type { FastifyPluginCallback } from 'fastify';
import { eq } from 'drizzle-orm';
import { loginPayloadSchema } from '@rhodes/shared';

import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import {
  COOKIE_SESSAO,
  criarSessao,
  destruirSessao,
  limparFalhasLogin,
  loginBloqueado,
  registrarFalhaLogin,
  requireUser,
} from '../lib/auth.js';
import { hashSenha, verificarSenha } from '../lib/passwords.js';

/** Mesma resposta para login inexistente e senha errada — não revelar o que falhou. */
const ERRO_LOGIN = 'Login ou senha inválidos.';

export const authRoutes: FastifyPluginCallback<{ db: Db }> = (app, opts, done) => {
  const { db } = opts;

  // Hash de referência para equalizar o tempo quando o login não existe (anti-enumeração).
  const hashFantasmaPromise = hashSenha('senha-fantasma-para-tempo-constante');

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ erro: 'Dados inválidos.' });
    }

    const login = parsed.data.login.toLowerCase();
    const chave = `${login}|${req.ip}`;

    if (loginBloqueado(chave)) {
      audit(db, { acao: 'RATE_LIMIT', entidade: 'auth', depois: { login }, ip: req.ip });
      return reply
        .status(429)
        .send({ erro: 'Muitas tentativas — aguarde 15 minutos e tente de novo.' });
    }

    const user = db.select().from(users).where(eq(users.login, login)).get();

    const senhaOk =
      user && user.ativo
        ? await verificarSenha(user.passwordHash, parsed.data.senha)
        : await verificarSenha(await hashFantasmaPromise, parsed.data.senha).then(() => false);

    if (!user || !user.ativo || !senhaOk) {
      registrarFalhaLogin(chave);
      audit(db, { acao: 'LOGIN_FALHA', entidade: 'auth', depois: { login }, ip: req.ip });
      return reply.status(401).send({ erro: ERRO_LOGIN });
    }

    limparFalhasLogin(chave);
    const { token } = criarSessao(db, user.id, req.ip);
    audit(db, { ator: { id: user.id, login: user.login }, acao: 'LOGIN_OK', ip: req.ip });

    reply.setCookie(COOKIE_SESSAO, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 12 * 60 * 60, // teto absoluto de 12h; o servidor desliza até 10h por request
    });

    return { id: user.id, nome: user.nome, login: user.login, role: user.role, ativo: user.ativo };
  });

  app.post('/api/auth/logout', { preHandler: requireUser(db) }, (req, reply) => {
    const token = req.cookies[COOKIE_SESSAO];
    if (token) destruirSessao(db, token);
    audit(db, { ator: { id: req.user!.id, login: req.user!.login }, acao: 'LOGOUT', ip: req.ip });
    reply.clearCookie(COOKIE_SESSAO, { path: '/' });
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', { preHandler: requireUser(db) }, (req) => {
    return req.user;
  });

  done();
};

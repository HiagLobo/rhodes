import { createHash, randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Role, Usuario } from '@rhodes/shared';

import type { Db } from '../db/index.js';
import { sessions, users } from '../db/schema.js';

/** Duração-alvo de uma sessão: 1 turno. Renovada a cada request autenticado (deslizante). */
const SESSAO_HORAS = 10;

export const COOKIE_SESSAO = 'rhodes_sessao';

declare module 'fastify' {
  interface FastifyRequest {
    user?: Usuario;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function novaExpiracao(): Date {
  return new Date(Date.now() + SESSAO_HORAS * 60 * 60 * 1000);
}

/** Cria a sessão e devolve o token EM CLARO (vai só para o cookie; o banco guarda o hash). */
export function criarSessao(db: Db, userId: number, ip?: string): { token: string } {
  const token = randomBytes(32).toString('base64url');
  db.insert(sessions)
    .values({ id: hashToken(token), userId, expiraEm: novaExpiracao(), ip: ip ?? null })
    .run();
  return { token };
}

/**
 * Valida o token do cookie: sessão existente, não expirada e usuário ativo.
 * Renova `expira_em` (expiração deslizante). Devolve o usuário público ou null.
 */
export function validarSessao(db: Db, token: string): Usuario | null {
  const id = hashToken(token);
  const row = db
    .select({
      expiraEm: sessions.expiraEm,
      userId: users.id,
      nome: users.nome,
      login: users.login,
      role: users.role,
      ativo: users.ativo,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, id))
    .get();

  if (!row || !row.ativo || row.expiraEm.getTime() <= Date.now()) {
    return null;
  }

  db.update(sessions).set({ expiraEm: novaExpiracao() }).where(eq(sessions.id, id)).run();

  return {
    id: row.userId,
    nome: row.nome,
    login: row.login,
    role: row.role as Role,
    ativo: row.ativo,
  };
}

export function destruirSessao(db: Db, token: string): void {
  db.delete(sessions).where(eq(sessions.id, hashToken(token))).run();
}

/** Revogação imediata (usuário desativado, reset forçado): derruba TODAS as sessões dele. */
export function revogarSessoesDoUsuario(db: Db, userId: number): void {
  db.delete(sessions).where(eq(sessions.userId, userId)).run();
}

// ---------------------------------------------------------------------------
// Rate-limit de login em memória (processo único por arquitetura): 5 falhas/15min
// por chave login|ip. Auditado pela rota quando bloqueia.
// ---------------------------------------------------------------------------

const JANELA_MS = 15 * 60 * 1000;
const MAX_FALHAS = 5;

const falhasPorChave = new Map<string, number[]>();

export function registrarFalhaLogin(chave: string): void {
  const agora = Date.now();
  const lista = (falhasPorChave.get(chave) ?? []).filter((t) => agora - t < JANELA_MS);
  lista.push(agora);
  falhasPorChave.set(chave, lista);
}

export function loginBloqueado(chave: string): boolean {
  const agora = Date.now();
  const lista = (falhasPorChave.get(chave) ?? []).filter((t) => agora - t < JANELA_MS);
  falhasPorChave.set(chave, lista);
  return lista.length >= MAX_FALHAS;
}

export function limparFalhasLogin(chave: string): void {
  falhasPorChave.delete(chave);
}

/** Só para testes — zera o estado do rate-limit. */
export function resetRateLimit(): void {
  falhasPorChave.clear();
}

// ---------------------------------------------------------------------------
// preHandlers de autorização (imutável 1: enforcement no endpoint, nunca na UI)
// ---------------------------------------------------------------------------

function autenticar(db: Db, req: FastifyRequest): Usuario | null {
  const token = req.cookies[COOKIE_SESSAO];
  if (!token) return null;
  return validarSessao(db, token);
}

export function requireUser(db: Db): preHandlerHookHandler {
  return function (req: FastifyRequest, reply: FastifyReply, done) {
    const user = autenticar(db, req);
    if (!user) {
      reply.status(401).send({ erro: 'Sessão inválida ou expirada — faça login.' });
      return done();
    }
    req.user = user;
    done();
  };
}

export function requireRole(db: Db, ...roles: Role[]): preHandlerHookHandler {
  return function (req: FastifyRequest, reply: FastifyReply, done) {
    const user = autenticar(db, req);
    if (!user) {
      reply.status(401).send({ erro: 'Sessão inválida ou expirada — faça login.' });
      return done();
    }
    if (!roles.includes(user.role)) {
      reply.status(403).send({ erro: 'Sem permissão para esta ação.' });
      return done();
    }
    req.user = user;
    done();
  };
}

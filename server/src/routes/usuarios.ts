import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginCallback } from 'fastify';
import { criarUsuarioSchema, resetSenhaSchema, type Usuario } from '@rhodes/shared';
import { z } from 'zod';

import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { requireRole, revogarSessoesDoUsuario } from '../lib/auth.js';
import { hashSenha, validarNovaSenha } from '../lib/passwords.js';
import { liberarInstanciasDe } from '../services/scheduler/instancias.js';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

function publico(u: typeof users.$inferSelect): Usuario {
  return {
    id: u.id,
    nome: u.nome,
    login: u.login,
    role: u.role as Usuario['role'],
    ativo: u.ativo,
  };
}

/** Gestão de usuários — TODAS as rotas exigem GESTOR no endpoint (imutável 1). */
export const usuariosRoutes: FastifyPluginCallback<{ db: Db }> = (app, opts, done) => {
  const { db } = opts;
  const somenteGestor = requireRole(db, 'GESTOR');

  app.get('/api/usuarios', { preHandler: somenteGestor }, () => {
    return db.select().from(users).orderBy(asc(users.nome)).all().map(publico);
  });

  app.post('/api/usuarios', { preHandler: somenteGestor }, async (req, reply) => {
    const parsed = criarUsuarioSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ erro: 'Dados inválidos.' });
    }
    const problemas = validarNovaSenha(parsed.data.senha);
    if (problemas.length > 0) {
      return reply.status(400).send({ erro: 'Senha não atende à política.', problemas });
    }
    const jaExiste = db.select().from(users).where(eq(users.login, parsed.data.login)).get();
    if (jaExiste) {
      return reply.status(409).send({ erro: 'Já existe um usuário com esse login.' });
    }

    const passwordHash = await hashSenha(parsed.data.senha);
    const criado = db
      .insert(users)
      .values({
        nome: parsed.data.nome,
        login: parsed.data.login,
        role: parsed.data.role,
        passwordHash,
      })
      .returning()
      .get();

    audit(db, {
      ator: { id: req.user!.id, login: req.user!.login },
      acao: 'USUARIO_CRIADO',
      entidade: 'users',
      entidadeId: criado.id,
      depois: publico(criado),
      ip: req.ip,
    });

    return reply.status(201).send(publico(criado));
  });

  app.post('/api/usuarios/:id/reset-senha', { preHandler: somenteGestor }, async (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    const body = resetSenhaSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ erro: 'Dados inválidos.' });
    }
    const problemas = validarNovaSenha(body.data.senha);
    if (problemas.length > 0) {
      return reply.status(400).send({ erro: 'Senha não atende à política.', problemas });
    }
    const alvo = db.select().from(users).where(eq(users.id, params.data.id)).get();
    if (!alvo) {
      return reply.status(404).send({ erro: 'Usuário não encontrado.' });
    }

    const passwordHash = await hashSenha(body.data.senha);
    db.update(users).set({ passwordHash }).where(eq(users.id, alvo.id)).run();
    // Senha trocada = sessões antigas não valem mais (segurança + ALCOA "atribuível").
    revogarSessoesDoUsuario(db, alvo.id);

    audit(db, {
      ator: { id: req.user!.id, login: req.user!.login },
      acao: 'SENHA_RESET',
      entidade: 'users',
      entidadeId: alvo.id,
      ip: req.ip,
    });

    return { ok: true };
  });

  app.post('/api/usuarios/:id/desativar', { preHandler: somenteGestor }, (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({ erro: 'Dados inválidos.' });
    }
    if (params.data.id === req.user!.id) {
      return reply.status(400).send({ erro: 'Você não pode desativar a si mesmo.' });
    }
    const alvo = db.select().from(users).where(eq(users.id, params.data.id)).get();
    if (!alvo) {
      return reply.status(404).send({ erro: 'Usuário não encontrado.' });
    }

    const atualizado = db
      .update(users)
      .set({ ativo: false })
      .where(eq(users.id, alvo.id))
      .returning()
      .get()!;
    revogarSessoesDoUsuario(db, alvo.id);
    // Tarefas em execução presas com o desativado voltam para a fila (imutável 10; Onda 03).
    liberarInstanciasDe(db, alvo.id, { id: req.user!.id, login: req.user!.login });

    audit(db, {
      ator: { id: req.user!.id, login: req.user!.login },
      acao: 'USUARIO_DESATIVADO',
      entidade: 'users',
      entidadeId: alvo.id,
      antes: publico(alvo),
      depois: publico(atualizado),
      ip: req.ip,
    });

    return reply.send(publico(atualizado));
  });

  app.post('/api/usuarios/:id/reativar', { preHandler: somenteGestor }, (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send({ erro: 'Dados inválidos.' });
    }
    const alvo = db.select().from(users).where(eq(users.id, params.data.id)).get();
    if (!alvo) {
      return reply.status(404).send({ erro: 'Usuário não encontrado.' });
    }

    const atualizado = db
      .update(users)
      .set({ ativo: true })
      .where(eq(users.id, alvo.id))
      .returning()
      .get()!;

    audit(db, {
      ator: { id: req.user!.id, login: req.user!.login },
      acao: 'USUARIO_REATIVADO',
      entidade: 'users',
      entidadeId: alvo.id,
      antes: publico(alvo),
      depois: publico(atualizado),
      ip: req.ip,
    });

    return reply.send(publico(atualizado));
  });

  done();
};

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Tabela técnica chave/valor — prova o pipeline de migração na S2 da Onda 00.
 * As tabelas de domínio chegam nas Ondas 01+ (sempre por migração aditiva).
 */
export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/**
 * Usuários do sistema (Onda 01/S1). `role` ∈ ROLES (@rhodes/shared).
 * `criado_em` tem default do SERVIDOR (unixepoch) — timestamp de negócio nunca é digitável (ALCOA+).
 * Exclusão é lógica via `ativo` — usuário nunca é apagado (a trilha de auditoria referencia ele).
 */
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nome: text('nome').notNull(),
  login: text('login').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull(),
  ativo: integer('ativo', { mode: 'boolean' }).notNull().default(true),
  criadoEm: integer('criado_em', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * Trilha de auditoria (Onda 01/S2) — APPEND-ONLY, imposto por triggers na migração 0002
 * (UPDATE/DELETE → RAISE(ABORT)). Toda ação significativa entra aqui via o helper audit().
 * `ator_login` é cópia textual: o registro continua atribuível mesmo se o usuário mudar (ALCOA "A").
 * id autoincrement = ordem monotônica dos eventos.
 */
/**
 * Sessões (Onda 01/S3). `id` é o SHA-256 do token — o token em claro só existe no cookie
 * do cliente (vazamento do banco não vira sessão válida). Expiração deslizante de ~1 turno:
 * `expira_em` é renovado a cada request autenticado (validarSessao).
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    criadoEm: integer('criado_em', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    expiraEm: integer('expira_em', { mode: 'timestamp' }).notNull(),
    ip: text('ip'),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  atorId: integer('ator_id').references(() => users.id),
  atorLogin: text('ator_login'),
  acao: text('acao').notNull(),
  entidade: text('entidade'),
  entidadeId: text('entidade_id'),
  antes: text('antes'),
  depois: text('depois'),
  ip: text('ip'),
  criadoEm: integer('criado_em', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

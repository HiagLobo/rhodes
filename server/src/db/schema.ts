import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Tabela técnica chave/valor — prova o pipeline de migração na S2.
 * As tabelas de domínio chegam nas Ondas 01+ (sempre por migração aditiva).
 */
export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

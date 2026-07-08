import type { Db } from '../db/index.js';
import { auditLog } from '../db/schema.js';

/** Chaves que nunca podem aparecer na trilha — redigidas em qualquer profundidade. */
const CHAVES_REDIGIDAS = new Set(['password_hash', 'passwordHash', 'senha']);

export type EntradaAuditoria = {
  /** Quem fez. Omitido/null = sistema ou anônimo (ex.: tentativa de login falha). */
  ator?: { id: number; login: string } | null;
  /** Ex.: LOGIN_OK, LOGIN_FALHA, RATE_LIMIT, LOGOUT, USUARIO_CRIADO, USUARIO_DESATIVADO… */
  acao: string;
  entidade?: string;
  entidadeId?: string | number;
  antes?: unknown;
  depois?: unknown;
  ip?: string;
};

function redigir(valor: unknown): unknown {
  if (Array.isArray(valor)) {
    return valor.map(redigir);
  }
  if (valor !== null && typeof valor === 'object') {
    return Object.fromEntries(
      Object.entries(valor as Record<string, unknown>).map(([chave, v]) => [
        chave,
        CHAVES_REDIGIDAS.has(chave) ? '[redigido]' : redigir(v),
      ]),
    );
  }
  return valor;
}

/**
 * Grava uma entrada na trilha de auditoria (INSERT síncrono, mesma conexão do chamador).
 * FAIL-CLOSED de propósito: se o insert falhar, a exceção sobe e a operação do chamador
 * falha junto — ação sem trilha não acontece (ALCOA+). `criado_em` é default do servidor.
 */
export function audit(db: Db, entrada: EntradaAuditoria): void {
  db.insert(auditLog)
    .values({
      atorId: entrada.ator?.id ?? null,
      atorLogin: entrada.ator?.login ?? null,
      acao: entrada.acao,
      entidade: entrada.entidade ?? null,
      entidadeId: entrada.entidadeId !== undefined ? String(entrada.entidadeId) : null,
      antes: entrada.antes !== undefined ? JSON.stringify(redigir(entrada.antes)) : null,
      depois: entrada.depois !== undefined ? JSON.stringify(redigir(entrada.depois)) : null,
      ip: entrada.ip ?? null,
    })
    .run();
}

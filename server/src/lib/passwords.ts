import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { hash, verify } from '@node-rs/argon2';

// server/assets fica a 2 níveis deste arquivo tanto em src/lib quanto em dist/lib.
const BLOCKLIST_PATH = fileURLToPath(new URL('../../assets/senhas-comuns.txt', import.meta.url));

export const SENHA_MIN = 8;
export const SENHA_MAX = 64;

let blocklist: Set<string> | null = null;

/** Top-10k senhas comuns (SecLists) — carregada uma vez; linhas iniciadas em # são comentário. */
function carregarBlocklist(): Set<string> {
  if (!blocklist) {
    const linhas = fs.readFileSync(BLOCKLIST_PATH, 'utf-8').split(/\r?\n/);
    blocklist = new Set(
      linhas.filter((l) => l.length > 0 && !l.startsWith('#')).map((l) => l.toLowerCase()),
    );
  }
  return blocklist;
}

/** Hash argon2id (defaults da lib — parâmetros OWASP). */
export function hashSenha(senha: string): Promise<string> {
  return hash(senha);
}

export function verificarSenha(hashArmazenado: string, senha: string): Promise<boolean> {
  return verify(hashArmazenado, senha);
}

/**
 * Política NIST 800-63B rev.4: comprimento + blocklist. SEM exigência de símbolo/número/maiúscula
 * e SEM expiração periódica — por design (arquitetura §8).
 * Retorna a lista de problemas em PT-BR (vazia = senha aceita).
 */
export function validarNovaSenha(senha: string): string[] {
  const problemas: string[] = [];
  if (senha.length < SENHA_MIN) {
    problemas.push(`A senha deve ter pelo menos ${SENHA_MIN} caracteres.`);
  }
  if (senha.length > SENHA_MAX) {
    problemas.push(`A senha deve ter no máximo ${SENHA_MAX} caracteres.`);
  }
  if (senha.length >= SENHA_MIN && carregarBlocklist().has(senha.toLowerCase())) {
    problemas.push('Essa senha é muito comum — escolha outra.');
  }
  return problemas;
}

import { describe, expect, it } from 'vitest';

import { hashSenha, validarNovaSenha, verificarSenha } from '../src/lib/passwords.js';

describe('hash de senha (argon2id)', () => {
  it('roundtrip: hash e verifica; senha errada falha', async () => {
    const h = await hashSenha('cevada moega recife');
    expect(await verificarSenha(h, 'cevada moega recife')).toBe(true);
    expect(await verificarSenha(h, 'senha-errada')).toBe(false);
  });

  it('usa argon2id', async () => {
    const h = await hashSenha('qualquer-senha-boa');
    expect(h.startsWith('$argon2id$')).toBe(true);
  });
});

describe('política de senha (NIST 800-63B rev.4)', () => {
  it('rejeita menos de 8 caracteres', () => {
    expect(validarNovaSenha('1234567').join(' ')).toMatch(/pelo menos 8/);
  });

  it('rejeita mais de 64 caracteres', () => {
    expect(validarNovaSenha('a'.repeat(65)).join(' ')).toMatch(/no máximo 64/);
  });

  it('rejeita senha comum pela blocklist (12345678 tem 8 chars mas é top-10k)', () => {
    expect(validarNovaSenha('12345678').join(' ')).toMatch(/muito comum/);
  });

  it('blocklist é case-insensitive', () => {
    expect(validarNovaSenha('PASSWORD1').join(' ')).toMatch(/muito comum/);
  });

  it('aceita passphrase sem símbolo/número/maiúscula (sem regra de complexidade, por design)', () => {
    expect(validarNovaSenha('cevada moega recife')).toEqual([]);
  });
});

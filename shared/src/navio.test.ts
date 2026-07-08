import { describe, expect, it } from 'vitest';

import { NAVIO_STATUS, proximaTransicao, transicaoValida } from './navio.js';

describe('FSM do navio — sequência estrita', () => {
  it('as 4 transições em ordem são válidas', () => {
    for (let i = 0; i < NAVIO_STATUS.length - 1; i++) {
      expect(transicaoValida(NAVIO_STATUS[i]!, NAVIO_STATUS[i + 1]!)).toBe(true);
    }
  });

  it('pular etapa é inválido', () => {
    expect(transicaoValida('ANUNCIADO', 'DESCARGA_INICIADA')).toBe(false);
    expect(transicaoValida('ATRACADO', 'DESATRACADO')).toBe(false);
  });

  it('voltar é inválido; permanecer é inválido', () => {
    expect(transicaoValida('DESCARGA_CONCLUIDA', 'ATRACADO')).toBe(false);
    expect(transicaoValida('ATRACADO', 'ATRACADO')).toBe(false);
  });

  it('proximaTransicao anda a sequência e termina em null', () => {
    expect(proximaTransicao('ANUNCIADO')).toBe('ATRACADO');
    expect(proximaTransicao('DESCARGA_CONCLUIDA')).toBe('DESATRACADO');
    expect(proximaTransicao('DESATRACADO')).toBeNull();
  });
});

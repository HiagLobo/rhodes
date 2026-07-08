import { describe, expect, it } from 'vitest';

import { dataRecife, diaDaSemana, diffDias, somarDias } from './agendamento.js';

describe('dataRecife — dia operacional no fuso do porto (UTC−3, sem DST)', () => {
  it('instante de madrugada UTC ainda é o dia ANTERIOR em Recife', () => {
    // 02:59Z de 8 de julho = 23:59 de 7 de julho em Recife
    expect(dataRecife(new Date('2026-07-08T02:59:00Z'))).toBe('2026-07-07');
  });

  it('03:00Z é meia-noite em Recife — vira o dia', () => {
    expect(dataRecife(new Date('2026-07-08T03:00:00Z'))).toBe('2026-07-08');
  });

  it('virada de ano', () => {
    expect(dataRecife(new Date('2027-01-01T01:00:00Z'))).toBe('2026-12-31');
  });
});

describe('somarDias', () => {
  it('atravessa mês e ano', () => {
    expect(somarDias('2026-01-31', 1)).toBe('2026-02-01');
    expect(somarDias('2026-12-31', 1)).toBe('2027-01-01');
    expect(somarDias('2026-07-08', 14)).toBe('2026-07-22');
  });

  it('dias negativos voltam no tempo', () => {
    expect(somarDias('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('ano bissexto', () => {
    expect(somarDias('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('diffDias', () => {
  it('positivo, negativo e zero', () => {
    expect(diffDias('2026-07-01', '2026-07-15')).toBe(14);
    expect(diffDias('2026-07-15', '2026-07-01')).toBe(-14);
    expect(diffDias('2026-07-08', '2026-07-08')).toBe(0);
  });

  it('atravessa ano', () => {
    expect(diffDias('2026-12-31', '2027-01-02')).toBe(2);
  });
});

describe('diaDaSemana', () => {
  it('datas conhecidas', () => {
    expect(diaDaSemana('2026-07-06')).toBe(1); // segunda
    expect(diaDaSemana('2026-07-08')).toBe(3); // quarta
    expect(diaDaSemana('2026-07-12')).toBe(0); // domingo
  });
});

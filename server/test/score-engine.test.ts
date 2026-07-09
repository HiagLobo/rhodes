import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCORE_CONFIG,
  bandaDoScore,
  type EntradaScore,
  type EventoInspecao,
  type EventoInstancia,
  type ScoreConfig,
} from '@rhodes/shared';

import { aprovacao, cobertura, creditoPontualidade, pontualidade, taxaJustificadas } from '../src/services/score/componentes.js';
import { calcularScore } from '../src/services/score/engine.js';

const CONFIG = DEFAULT_SCORE_CONFIG;
// Para isolar a regra-base de denominador do teto por executante (que, com poucas tarefas,
// tem permitido=floor(0,2·n)=0 e degradaria até 1 externa legítima).
const CONFIG_SEM_TETO: ScoreConfig = { ...DEFAULT_SCORE_CONFIG, tetoJustificativasExecutantePct: 100 };

/** Instância concluída com `atraso` dias sobre o due, para a frequência dada. */
function inst(over: Partial<EventoInstancia> & { frequenciaDias: number }): EventoInstancia {
  return {
    templateId: 1,
    areaId: 1,
    dueDate: '2026-07-01',
    finishedAt: null,
    status: 'DONE_ON_TIME',
    origin: 'CALENDAR',
    executanteId: 1,
    ...over,
  };
}

/** Instância concluída `atraso` dias após o due (finishedAt = due + atraso, meio-dia Recife). */
function concluida(atraso: number, freq: number, over: Partial<EventoInstancia> = {}): EventoInstancia {
  const due = '2026-07-01';
  const [y, m, d] = due.split('-').map(Number);
  const fin = new Date(Date.UTC(y!, m! - 1, d! + atraso, 15)); // 12:00 Recife
  return inst({ frequenciaDias: freq, dueDate: due, finishedAt: fin, status: atraso === 0 ? 'DONE_ON_TIME' : 'DONE_LATE', ...over });
}

function insp(over: Partial<EventoInspecao> = {}): EventoInspecao {
  return { areaId: 1, resultado: 'APROVADA', primeiraVistoria: true, dataRecife: '2026-07-05', ...over };
}

describe('creditoPontualidade — curva confirmada (platô + (1−r)/0,90)', () => {
  it('QUINZENAL D=14, graça 0,10: 1 dia = crédito cheio (custo 0%); 10 dias = 0,31746 (custo 68,25%)', () => {
    expect(creditoPontualidade(1, 14, 0.1)).toBe(1); // r=0,0714 ≤ 0,10 → platô, custo 0,00%
    expect(creditoPontualidade(10, 14, 0.1)).toBeCloseTo(0.31746, 5); // custo 68,25%
  });

  it('fronteiras: r=graça → 1; r=1 → 0; r>1 → 0; atraso ≤0 → 1', () => {
    expect(creditoPontualidade(1.4, 14, 0.1)).toBe(1); // r=0,10 exato
    expect(creditoPontualidade(14, 14, 0.1)).toBe(0); // r=1
    expect(creditoPontualidade(20, 14, 0.1)).toBe(0); // r>1
    expect(creditoPontualidade(0, 14, 0.1)).toBe(1);
    expect(creditoPontualidade(-3, 14, 0.1)).toBe(1);
  });

  it('SEMANAL D=7: 1 dia = 0,95238 (o grace arredondado NÃO é atalho)', () => {
    expect(creditoPontualidade(1, 7, 0.1)).toBeCloseTo(0.95238, 5);
    expect(creditoPontualidade(7, 7, 0.1)).toBe(0);
  });
});

describe('pontualidade — denominadores (o campo minado)', () => {
  it('EXTERNA aprovada sai do numerador E do denominador (não conta em n)', () => {
    const eventos = [
      concluida(10, 14), // atrasada de verdade
      concluida(10, 14, { justificativa: { classificacao: 'EXTERNA', status: 'APROVADA' } }),
    ];
    const r = pontualidade(eventos, CONFIG_SEM_TETO);
    expect(r.n).toBe(1); // só a atrasada conta
    expect(r.valor).toBeCloseTo(0.31746, 5); // média = só a atrasada
  });

  it('INTERNA aprovada = crédito 0,5 (conta)', () => {
    const r = pontualidade([concluida(10, 14, { justificativa: { classificacao: 'INTERNA', status: 'APROVADA' } })], CONFIG);
    expect(r).toEqual({ valor: 0.5, n: 1 });
  });

  it('PENDENTE e REPROVADA = curva normal (justificativa sem efeito até decisão)', () => {
    const pend = pontualidade([concluida(10, 14, { justificativa: { classificacao: 'EXTERNA', status: 'PENDENTE' } })], CONFIG);
    expect(pend.valor).toBeCloseTo(0.31746, 5); // conta pela curva
    const rep = pontualidade([concluida(10, 14, { justificativa: { classificacao: 'EXTERNA', status: 'REPROVADA' } })], CONFIG);
    expect(rep.valor).toBeCloseTo(0.31746, 5);
  });

  it('MISSED sem justificativa aprovada = crédito 0 (conta)', () => {
    const r = pontualidade([inst({ frequenciaDias: 14, status: 'MISSED' })], CONFIG);
    expect(r).toEqual({ valor: 0, n: 1 });
  });

  it('instância ainda aberta não é de pontualidade', () => {
    expect(pontualidade([inst({ frequenciaDias: 14, status: 'OVERDUE' })], CONFIG)).toEqual({ valor: null, n: 0 });
  });

  it('teto por executante: externas excedentes degradam para 0,5', () => {
    // executante 7 com 4 instâncias, 3 externas aprovadas; teto 20% → permitido floor(0,2·4)=0
    // logo TODAS as 3 externas degradam para 0,5; + 1 atrasada normal
    const eventos = [
      concluida(0, 14, { executanteId: 7 }), // pontual (crédito 1)
      concluida(0, 14, { executanteId: 7, justificativa: { classificacao: 'EXTERNA', status: 'APROVADA' } }),
      concluida(0, 14, { executanteId: 7, justificativa: { classificacao: 'EXTERNA', status: 'APROVADA' } }),
      concluida(0, 14, { executanteId: 7, justificativa: { classificacao: 'EXTERNA', status: 'APROVADA' } }),
    ];
    const r = pontualidade(eventos, CONFIG);
    // permitido=0 → as 3 externas contam como 0,5; a pontual conta 1 → soma=1+0,5·3=2,5; n=4
    expect(r.n).toBe(4);
    expect(r.valor).toBeCloseTo(2.5 / 4, 5);
  });

  it('componente vazio → valor null (nunca NaN)', () => {
    expect(pontualidade([], CONFIG)).toEqual({ valor: null, n: 0 });
  });
});

describe('aprovacao e cobertura', () => {
  it('aprovação = 1ª passagem; retrabalho (não-1ª) fora do denominador; SEM filtro amostral', () => {
    const r = aprovacao([
      insp({ resultado: 'APROVADA' }),
      insp({ resultado: 'REPROVADA' }),
      insp({ resultado: 'APROVADA', primeiraVistoria: false }), // retrabalho: ignorado
    ]);
    expect(r).toEqual({ valor: 0.5, n: 2 });
  });

  it('aprovação vazia → null (nunca NaN nem 0 punitivo)', () => {
    expect(aprovacao([])).toEqual({ valor: null, n: 0 });
  });

  it('cobertura = snapshot: templates sem vencida aberta / ativos', () => {
    const ativos = [{ templateId: 1 }, { templateId: 2 }, { templateId: 3 }, { templateId: 4 }];
    expect(cobertura(ativos, new Set([2]))).toEqual({ valor: 0.75, n: 4 });
    expect(cobertura([], new Set())).toEqual({ valor: null, n: 0 });
  });
});

describe('bandaDoScore — limiares contínuos sem buraco', () => {
  it('cobre 85,5 e 95,5', () => {
    expect(bandaDoScore(96)).toBe('EXCELENTE');
    expect(bandaDoScore(95.5)).toBe('BOM');
    expect(bandaDoScore(86)).toBe('BOM');
    expect(bandaDoScore(85.5)).toBe('ATENCAO');
    expect(bandaDoScore(70)).toBe('ATENCAO');
    expect(bandaDoScore(69.9)).toBe('CRITICO');
  });
});

describe('taxaJustificadas — denominador bruto (externa aprovada continua visível)', () => {
  it('1 externa aprovada + 1 atraso puro → taxa 0,5 enquanto pontualidade.n = 1', () => {
    const eventos = [
      concluida(10, 14), // atraso puro
      concluida(0, 14, { justificativa: { classificacao: 'EXTERNA', status: 'APROVADA' } }),
    ];
    expect(taxaJustificadas(eventos)).toBe(0.5); // 1 justificada / 2 fechadas
    expect(pontualidade(eventos, CONFIG_SEM_TETO).n).toBe(1); // a externa saiu do denominador
  });
});

// ------------------------------------------------------------- engine (renorm + agregação)

function entrada(over: Partial<EntradaScore>): EntradaScore {
  return {
    instancias: [],
    inspecoes: [],
    demeritos: [],
    templatesAtivos: [],
    templatesComVencidaAberta: new Set(),
    areas: [{ areaId: 1, nome: 'A1', peso: 1 }],
    ...over,
  };
}

describe('calcularScore — renormalização dinâmica', () => {
  it('P=A=C=1 → 100; deméritos após reescalar; teto −20', () => {
    const e = entrada({
      instancias: [concluida(0, 14)], // crédito 1
      inspecoes: [insp({ resultado: 'APROVADA' })], // 1
      templatesAtivos: [{ templateId: 1, areaId: 1 }],
      templatesComVencidaAberta: new Set(), // cobertura 1
    });
    expect(calcularScore(e, CONFIG).score).toBe(100);

    const comDem = calcularScore({ ...e, demeritos: [{ areaId: 1, severidade: 'CRITICA', dataRecife: '2026-07-03' }] }, CONFIG);
    expect(comDem.score).toBe(92); // 100 − 8
  });

  it('componente ausente (aprovação n=0) renormaliza pelos presentes — não pune ~25 pts', () => {
    const e = entrada({
      instancias: [concluida(0, 14)], // P=1
      inspecoes: [], // A ausente
      templatesAtivos: [{ templateId: 1, areaId: 1 }],
      templatesComVencidaAberta: new Set(), // C=1
    });
    const r = calcularScore(e, CONFIG);
    expect(r.componentes.aprovacao.valor).toBeNull();
    expect(r.score).toBe(100); // (30·1+15·1)/(30+15)·100 = 100, não 78,6
  });

  it('P=0,5,A=1,C=1 → 78,571', () => {
    const e = entrada({
      instancias: [concluida(0, 14), inst({ frequenciaDias: 14, status: 'MISSED' })], // média (1+0)/2 = 0,5
      inspecoes: [insp()],
      templatesAtivos: [{ templateId: 1, areaId: 1 }],
      templatesComVencidaAberta: new Set(),
    });
    expect(calcularScore(e, CONFIG).score).toBeCloseTo(78.571, 2);
  });

  it('todos os componentes vazios → score null (nunca 0 punitivo)', () => {
    expect(calcularScore(entrada({}), CONFIG).score).toBeNull();
  });

  it('editar peso muda o resultado (config-driven)', () => {
    const e = entrada({
      instancias: [concluida(0, 14), inst({ frequenciaDias: 14, status: 'MISSED' })], // P=0,5
      inspecoes: [insp()], // A=1
      templatesAtivos: [{ templateId: 1, areaId: 1 }],
      templatesComVencidaAberta: new Set(), // C=1
    });
    const base = calcularScore(e, CONFIG).score!;
    const pesado: ScoreConfig = { ...CONFIG, pesos: { pontualidade: 60, aprovacao: 25, cobertura: 15 } };
    const outro = calcularScore(e, pesado).score!;
    expect(outro).not.toBeCloseTo(base, 3); // mais peso na pontualidade (0,5) baixa o score
    expect(outro).toBeLessThan(base);
  });
});

describe('calcularScore — agregação e incerteza', () => {
  it('geral = média ponderada por peso REAL; área sem dado é excluída', () => {
    // A1 (peso 1,5) score 80; A2 (peso 1,0) score 60; A3 (peso 5) sem dado → excluída
    const e: EntradaScore = {
      instancias: [
        // A1: P para dar 80 após renorm só-P (peso qualquer, single component → valor·100)
        ...instanciasParaCredito(0.8, 14, 1),
        ...instanciasParaCredito(0.6, 14, 2),
      ],
      inspecoes: [],
      demeritos: [],
      templatesAtivos: [],
      templatesComVencidaAberta: new Set(),
      areas: [
        { areaId: 1, nome: 'A1', peso: 1.5 },
        { areaId: 2, nome: 'A2', peso: 1.0 },
        { areaId: 3, nome: 'A3', peso: 5 }, // sem eventos → score null
      ],
    };
    const r = calcularScore(e, CONFIG);
    const a1 = r.areas.find((a) => a.areaId === 1)!;
    const a2 = r.areas.find((a) => a.areaId === 2)!;
    const a3 = r.areas.find((a) => a.areaId === 3)!;
    expect(a1.score).toBeCloseTo(80, 5);
    expect(a2.score).toBeCloseTo(60, 5);
    expect(a3.score).toBeNull();
    // (80·1,5 + 60·1,0)/2,5 = 72 (A3 fora)
    expect(r.score).toBeCloseTo(72, 5);
  });

  it('incerteza: nTotal (=n pontualidade) 1→25, 4→20, 16→10', () => {
    const mk = (nInst: number) =>
      calcularScore(
        entrada({ instancias: instanciasParaCredito(1, 14, 1, nInst), areas: [{ areaId: 1, nome: 'A1', peso: 1 }] }),
        CONFIG,
      );
    const r1 = mk(1);
    expect(r1.n).toBe(1);
    expect(r1.incertezaMenos).toBe(75); // score 100 − 25
    const r4 = mk(4);
    expect(r4.score! - r4.incertezaMenos!).toBe(20);
    const r16 = mk(16);
    expect(r16.score! - r16.incertezaMenos!).toBe(10);
  });

  it('recalculável: mesma entrada + config → mesmo score', () => {
    const e = entrada({
      instancias: [concluida(3, 14), concluida(0, 7)],
      inspecoes: [insp(), insp({ resultado: 'REPROVADA' })],
      templatesAtivos: [{ templateId: 1, areaId: 1 }],
      templatesComVencidaAberta: new Set(),
    });
    expect(calcularScore(e, CONFIG).score).toBe(calcularScore(e, CONFIG).score);
  });
});

/** Gera `n` instâncias no area/freq dados cuja pontualidade média = `credito` alvo (usa 1 e 0). */
function instanciasParaCredito(credito: number, freq: number, areaId: number, n = 10): EventoInstancia[] {
  const pontuais = Math.round(credito * n);
  const out: EventoInstancia[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      i < pontuais
        ? concluida(0, freq, { areaId })
        : inst({ frequenciaDias: freq, areaId, status: 'MISSED' }),
    );
  }
  return out;
}

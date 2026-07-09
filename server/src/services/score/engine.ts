import { bandaDoScore } from '@rhodes/shared';
import type {
  DemeritoInput,
  EntradaScore,
  EventoInspecao,
  EventoInstancia,
  ScoreArea,
  ScoreConfig,
  ScoreEscopo,
  ScoreResultado,
} from '@rhodes/shared';

import { aprovacao, cobertura, pontualidade, taxaJustificadas } from './componentes.js';

/**
 * Renormalização DINÂMICA pelos componentes PRESENTES (n>0). Resolve dois problemas de uma vez:
 * (1) n=0 — uma área sem inspeção NÃO é punida em ~25 pts por dado que nunca existiu; (2) pesos
 * editáveis — o denominador é a soma dos pesos dos componentes presentes, nunca 70 fixo.
 * Retorna null quando TODOS os componentes estão ausentes.
 */
function renormalizar(
  componentes: { valor: number | null; peso: number }[],
): number | null {
  const presentes = componentes.filter((c) => c.valor !== null);
  if (presentes.length === 0) return null;
  const somaPesos = presentes.reduce((s, c) => s + c.peso, 0);
  if (somaPesos <= 0) return null;
  const soma = presentes.reduce((s, c) => s + c.peso * (c.valor as number), 0);
  return (soma / somaPesos) * 100;
}

function somaDemeritos(demeritos: DemeritoInput[], config: ScoreConfig): number {
  const bruto = demeritos.reduce((s, d) => s + (config.demerito[d.severidade] ?? 0), 0);
  return Math.min(config.tetoDemeritos, bruto);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Incerteza heurística (DECISÃO da onda): faixa por n do denominador de pontualidade. */
function incerteza(score: number, nPontualidade: number): { mais: number; menos: number } {
  const banda = Math.min(25, Math.round(40 / Math.sqrt(Math.max(1, nPontualidade))));
  return { mais: clamp(score + banda, 0, 100), menos: clamp(score - banda, 0, 100) };
}

/** Calcula um ESCOPO (geral ou área) a partir dos eventos já daquele escopo. */
function calcularEscopo(
  instancias: EventoInstancia[],
  inspecoes: EventoInspecao[],
  demeritos: DemeritoInput[],
  templatesAtivos: { templateId: number }[],
  templatesComVencidaAberta: Set<number>,
  config: ScoreConfig,
): ScoreEscopo {
  const p = pontualidade(instancias, config);
  const a = aprovacao(inspecoes);
  const c = cobertura(templatesAtivos, templatesComVencidaAberta);

  const base = renormalizar([
    { valor: p.valor, peso: config.pesos.pontualidade },
    { valor: a.valor, peso: config.pesos.aprovacao },
    { valor: c.valor, peso: config.pesos.cobertura },
  ]);

  const dem = somaDemeritos(demeritos, config);
  const score = base === null ? null : clamp(base - dem, 0, 100);
  const inc = score === null ? { mais: null, menos: null } : incerteza(score, p.n);

  return {
    score,
    banda: score === null ? null : bandaDoScore(score),
    componentes: { pontualidade: p, aprovacao: a, cobertura: c },
    demeritos: dem,
    n: p.n,
    incertezaMais: inc.mais,
    incertezaMenos: inc.menos,
    taxaJustificadas: taxaJustificadas(instancias),
  };
}

/**
 * Ponto de entrada da engine (PURO): eventos brutos + config → score geral e por área.
 * Sempre recalculável — nenhum estado escondido. A janela já foi aplicada pelo coletor (S4);
 * a engine não toca em `Date` (determinismo do módulo).
 */
export function calcularScore(entrada: EntradaScore, config: ScoreConfig): ScoreResultado {
  const geral = calcularEscopo(
    entrada.instancias,
    entrada.inspecoes,
    entrada.demeritos,
    entrada.templatesAtivos,
    entrada.templatesComVencidaAberta,
    config,
  );

  const areas: ScoreArea[] = entrada.areas.map((area) => {
    const escopo = calcularEscopo(
      entrada.instancias.filter((i) => i.areaId === area.areaId),
      entrada.inspecoes.filter((i) => i.areaId === area.areaId),
      entrada.demeritos.filter((d) => d.areaId === area.areaId),
      entrada.templatesAtivos.filter((t) => t.areaId === area.areaId),
      entrada.templatesComVencidaAberta,
      config,
    );
    return { ...escopo, areaId: area.areaId, nome: area.nome };
  });

  // Score GERAL = média ponderada dos scores de área por peso, ignorando áreas com score null.
  const comScore = areas.filter((a) => a.score !== null);
  const somaPesos = comScore.reduce(
    (s, a) => s + (entrada.areas.find((x) => x.areaId === a.areaId)?.peso ?? 1),
    0,
  );
  const scoreGeral =
    comScore.length === 0 || somaPesos <= 0
      ? null
      : clamp(
          comScore.reduce(
            (s, a) => s + (a.score as number) * (entrada.areas.find((x) => x.areaId === a.areaId)?.peso ?? 1),
            0,
          ) / somaPesos,
          0,
          100,
        );

  return {
    ...geral,
    // o score geral usa a AGREGAÇÃO PONDERADA por área (não o escopo global achatado), mas
    // mantém os componentes/incerteza/taxa do escopo global como visão de conjunto.
    score: scoreGeral,
    banda: scoreGeral === null ? null : bandaDoScore(scoreGeral),
    incertezaMais: scoreGeral === null ? null : incerteza(scoreGeral, geral.n).mais,
    incertezaMenos: scoreGeral === null ? null : incerteza(scoreGeral, geral.n).menos,
    areas,
  };
}

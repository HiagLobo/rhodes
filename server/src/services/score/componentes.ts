import { dataRecife, diffDias } from '@rhodes/shared';
import type {
  ComponenteScore,
  EventoInspecao,
  EventoInstancia,
  ScoreConfig,
} from '@rhodes/shared';

// REGRA DO MÓDULO (Onda 03): funções PURAS, sem Date.now()/new Date() — instantes chegam de
// fora. A engine de score é 100% recalculável a partir dos eventos brutos (evento é a verdade).

/**
 * Crédito de pontualidade de UMA instância (curva confirmada — ver ESTADO da Onda 08):
 * `r = max(0, atraso)/frequencia`; crédito `1` até `r ≤ graca`; senão `(1−r)/(1−graca)`;
 * `0` se `r ≥ 1`. NUNCA usar o status DONE_ON_TIME como atalho — o grace arredondado diverge
 * do platô; recomputar `r` sempre.
 */
export function creditoPontualidade(
  atrasoDias: number,
  frequenciaDias: number,
  graca: number,
): number {
  const r = Math.max(0, atrasoDias) / frequenciaDias;
  if (r <= graca) return 1;
  if (r >= 1) return 0;
  return (1 - r) / (1 - graca);
}

/** Atraso em dias de uma instância concluída (0 se ainda aberta ou concluída no prazo/antes). */
function atrasoDe(inst: EventoInstancia): number {
  if (!inst.finishedAt) return 0;
  return Math.max(0, diffDias(inst.dueDate, dataRecife(inst.finishedAt)));
}

/** Uma justificativa aprovada e externa desta instância? (só APROVADA muda o denominador). */
function externaAprovada(inst: EventoInstancia): boolean {
  return (
    inst.justificativa?.status === 'APROVADA' && inst.justificativa.classificacao === 'EXTERNA'
  );
}

function internaAprovada(inst: EventoInstancia): boolean {
  return (
    inst.justificativa?.status === 'APROVADA' && inst.justificativa.classificacao === 'INTERNA'
  );
}

/**
 * Pontualidade da janela (o "campo minado" dos denominadores):
 * - EXTERNA aprovada → fora do numerador E do denominador (não conta em n) — salvo teto por
 *   executante, quando a excedente degrada para 0,5;
 * - INTERNA aprovada → crédito 0,5 (conta);
 * - PENDENTE / REPROVADA → sem efeito de justificativa: crédito pela curva (0 se MISSED); conta;
 * - MISSED sem justificativa aprovada → crédito 0 (conta);
 * - instância ainda aberta → não é de pontualidade (é cobertura).
 */
export function pontualidade(eventos: EventoInstancia[], config: ScoreConfig): ComponenteScore {
  // TETO POR EXECUTANTE: por executante, permitido = floor(pct/100 · total); externas
  // aprovadas excedentes (as mais recentes) degradam para 0,5 (entram em n como interna).
  const degradadas = executantesDegradados(eventos, config.tetoJustificativasExecutantePct);

  let soma = 0;
  let n = 0;
  for (const inst of eventos) {
    if (estaAberta(inst)) continue; // pertence à cobertura, não à pontualidade

    if (externaAprovada(inst) && !degradadas.has(inst)) {
      continue; // fora do numerador E do denominador
    }
    if (internaAprovada(inst) || (externaAprovada(inst) && degradadas.has(inst))) {
      soma += 0.5;
      n += 1;
      continue;
    }
    // PENDENTE, REPROVADA ou sem justificativa: curva (MISSED → atraso "cheio" → crédito 0).
    soma += inst.status === 'MISSED' ? 0 : creditoPontualidade(atrasoDe(inst), inst.frequenciaDias, config.gracaPontualidade);
    n += 1;
  }
  return { valor: n === 0 ? null : soma / n, n };
}

/** Instância ainda aberta no fim da janela (não concluída nem perdida). */
function estaAberta(inst: EventoInstancia): boolean {
  return inst.status === 'PENDING' || inst.status === 'IN_PROGRESS' || inst.status === 'OVERDUE';
}

/**
 * Conjunto das instâncias EXTERNAS-aprovadas que estouram o teto do seu executante e por isso
 * degradam para 0,5. O `dueDate` mais recente cede primeiro (as antigas mantêm o benefício).
 */
function executantesDegradados(
  eventos: EventoInstancia[],
  tetoPct: number,
): Set<EventoInstancia> {
  const degradadas = new Set<EventoInstancia>();
  const porExecutante = new Map<number, EventoInstancia[]>();
  const totalPorExecutante = new Map<number, number>();

  for (const inst of eventos) {
    if (estaAberta(inst) || inst.executanteId === null) continue;
    totalPorExecutante.set(inst.executanteId, (totalPorExecutante.get(inst.executanteId) ?? 0) + 1);
    if (externaAprovada(inst)) {
      porExecutante.set(inst.executanteId, [...(porExecutante.get(inst.executanteId) ?? []), inst]);
    }
  }

  for (const [exec, externas] of porExecutante) {
    const total = totalPorExecutante.get(exec) ?? 0;
    const permitido = Math.floor((tetoPct / 100) * total);
    if (externas.length <= permitido) continue;
    // ordena por dueDate DESC (mais recentes primeiro) e degrada o excedente
    const ordenadas = [...externas].sort((a, b) => (a.dueDate < b.dueDate ? 1 : a.dueDate > b.dueDate ? -1 : 0));
    for (let i = 0; i < externas.length - permitido; i++) degradadas.add(ordenadas[i]!);
  }
  return degradadas;
}

/**
 * Aprovação = taxa de aprovação em 1ª vistoria (retrabalho fora). SEM filtro por amostral
 * (amostral é seleção da Onda 06, não peso de score). Já vem filtrada pela janela.
 */
export function aprovacao(inspecoes: EventoInspecao[]): ComponenteScore {
  const primeira = inspecoes.filter((i) => i.primeiraVistoria);
  if (primeira.length === 0) return { valor: null, n: 0 };
  const aprovadas = primeira.filter((i) => i.resultado === 'APROVADA').length;
  return { valor: aprovadas / primeira.length, n: primeira.length };
}

/**
 * Cobertura = SNAPSHOT no fim da janela: % de templates ativos SEM instância vencida aberta.
 * Não é taxa sobre a janela; é ponto-no-tempo (pega tarefa esquecida).
 */
export function cobertura(
  templatesAtivos: { templateId: number }[],
  templatesComVencidaAberta: Set<number>,
): ComponenteScore {
  const n = templatesAtivos.length;
  if (n === 0) return { valor: null, n: 0 };
  const semVencida = templatesAtivos.filter((t) => !templatesComVencidaAberta.has(t.templateId)).length;
  return { valor: semVencida / n, n };
}

/** Taxa de justificadas — denominador BRUTO (todas as instâncias fechadas/perdidas da janela,
 *  antes de qualquer exclusão) para a externa aprovada continuar VISÍVEL na métrica. */
export function taxaJustificadas(eventos: EventoInstancia[]): number {
  const fechadas = eventos.filter((i) => !estaAberta(i));
  if (fechadas.length === 0) return 0;
  const justificadas = fechadas.filter((i) => i.justificativa !== undefined).length;
  return justificadas / fechadas.length;
}

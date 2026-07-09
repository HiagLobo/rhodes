import { somarDias } from '@rhodes/shared';

import { maisTarde, proximaAncoraFixed, type InstanciaRow, type TemplateRow } from './instancias.js';

// REGRA DO MÓDULO: função PURA e SOMENTE LEITURA — jamais escreve no banco. A projeção do
// calendário reusa proximaAncoraFixed (nunca duplica a regra de âncora do motor).

const MAX_ITERACOES = 400; // trava anti-loop por template (protege até o ramo FLOATING)

export type ProjecaoItem = { dia: string; templateId: number };

/**
 * Projeta as próximas ocorrências de UM template, a partir da sua instância aberta, até o fim
 * do mês pedido (`fimMes`, YYYY-MM-DD do último dia). Espelha o motor:
 * - o primeiro salto parte de `maisTarde(hoje, dueAberta)` — aberta OVERDUE não gera dias no
 *   passado (o motor real salta datas vencidas);
 * - aberta `origin='SHIP'` reproduz o RESET TOTAL: o primeiro salto é hoje+intervalo (a
 *   próxima instância nasce CALENDAR e volta ao ritmo normal);
 * - FIXED usa proximaAncoraFixed; FLOATING assume "conclusão no dia agendado" (dueAnterior +
 *   intervalDays) — premissa explícita no contrato/UI;
 * - template com intervalDays<=0 é PULADO (mesma defesa do motor).
 * A instância ABERTA em si NÃO entra (ela já é materializada — a rota a devolve à parte).
 */
export function projetarTemplate(
  template: TemplateRow,
  aberta: InstanciaRow,
  hoje: string,
  fimMes: string,
): ProjecaoItem[] {
  if (template.intervalDays <= 0) return [];

  const itens: ProjecaoItem[] = [];
  const floating = template.scheduleMode === 'FLOATING';
  let anterior = aberta.dueDate;
  let primeiro = true;

  for (let i = 0; i < MAX_ITERACOES; i++) {
    let proxima: string;
    if (primeiro && aberta.origin === 'SHIP') {
      // reset total: a próxima é hoje + intervalo (a âncora FIXED não deriva de data de navio)
      proxima = somarDias(maisTarde(hoje, aberta.dueDate), template.intervalDays);
    } else if (floating) {
      proxima = somarDias(maisTarde(hoje, anterior), template.intervalDays);
    } else {
      proxima = proximaAncoraFixed(template, anterior, hoje);
    }
    primeiro = false;
    if (proxima > fimMes) break;
    itens.push({ dia: proxima, templateId: template.id });
    anterior = proxima;
  }
  return itens;
}

/** Último dia (YYYY-MM-DD) do mês YYYY-MM. */
export function fimDoMes(mes: string): string {
  const [y, m] = mes.split('-').map(Number);
  // dia 0 do mês seguinte = último dia deste mês
  return new Date(Date.UTC(y!, m!, 0, 12)).toISOString().slice(0, 10);
}

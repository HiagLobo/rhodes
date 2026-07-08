import { eq } from 'drizzle-orm';
import {
  ADIAMENTO_POR_MOTIVO,
  dataRecife,
  diaDaSemana,
  somarDias,
  STATUS_ABERTOS,
  type MotivoJustificativa,
} from '@rhodes/shared';

import type { Db } from '../../db/index.js';
import { justificativas, taskInstances, taskTemplates } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { criarInstancia, type InstanciaRow, type TemplateRow } from './instancias.js';

// REGRA DO MÓDULO (Onda 03): determinismo — `agora` SEMPRE chega de fora.
// Date.now()/new Date() são proibidos em services/scheduler/ (verificado por grep no CI da sub).

export class ConclusaoInvalidaError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ConclusaoInvalidaError';
  }
}

export type Ator = { id: number; login: string };

export type ResultadoConclusao = {
  concluida: InstanciaRow;
  statusFinal: 'DONE_ON_TIME' | 'DONE_LATE';
  proxima: InstanciaRow | null;
};

function maisTarde(a: string, b: string): string {
  return a >= b ? a : b; // YYYY-MM-DD compara lexicograficamente
}

/**
 * Próxima âncora FIXED estritamente DEPOIS de hoje E do due consumido — conclusão
 * ADIANTADA não pode regenerar o mesmo slot de calendário (achado da revisão adversarial),
 * e dias perdidos são saltados sem empilhar.
 */
function proximaAncoraFixed(template: TemplateRow, dueAnterior: string, hoje: string): string {
  if (template.intervalDays <= 0) {
    throw new ConclusaoInvalidaError('Template com intervalo inválido.'); // defesa contra loop
  }
  const base = maisTarde(hoje, dueAnterior);
  if (template.frequency === 'DIARIO') {
    return somarDias(base, 1);
  }
  if (template.frequency === 'SEMANAL') {
    const alvo = template.fixedDow ?? 1; // segunda por default (decisão da onda)
    if (alvo < 0 || alvo > 6) {
      throw new ConclusaoInvalidaError('Âncora semanal (fixed_dow) fora de 0..6.');
    }
    let d = somarDias(base, 1);
    while (diaDaSemana(d) !== alvo) d = somarDias(d, 1);
    return d;
  }
  // Genérico: sempre consome a âncora anterior (≥1 passo) e salta o que ficou no passado.
  let d = somarDias(dueAnterior, template.intervalDays);
  while (d <= hoje) d = somarDias(d, template.intervalDays);
  return d;
}

/**
 * 1º ponto do motor (arquitetura §4.4): concluir uma instância ABERTA e materializar a
 * próxima ocorrência de calendário. Transacional: fechar sem gerar a próxima deixaria o
 * procedimento órfão (o bootstrap do dailyJob só cobre templates SEM nenhuma instância).
 *
 * - Janela dos 10% INCLUSIVA: concluir no próprio window_end é DONE_ON_TIME.
 * - FLOATING: próxima conta do dia da conclusão (limpar zera o relógio de sujeira).
 * - FIXED: próxima volta para a âncora do calendário, saltando dias perdidos.
 * - SHIP_EVENT puro e template inativo: não geram próxima.
 */
export function onComplete(
  db: Db,
  instanciaId: number,
  ator: Ator,
  agora: Date,
  ip?: string,
): ResultadoConclusao {
  return db.transaction((tx) => {
    // O shape de consulta da transação é o mesmo do Db (tipagem do drizzle é que difere).
    const t = tx as unknown as Db;

    const inst = t.select().from(taskInstances).where(eq(taskInstances.id, instanciaId)).get();
    if (!inst) {
      throw new ConclusaoInvalidaError('Instância não encontrada.');
    }
    if (!(STATUS_ABERTOS as readonly string[]).includes(inst.status)) {
      throw new ConclusaoInvalidaError('Instância já fechada — nada para concluir.');
    }

    const template = t
      .select()
      .from(taskTemplates)
      .where(eq(taskTemplates.id, inst.templateId))
      .get()!;

    const hoje = dataRecife(agora);
    const statusFinal: ResultadoConclusao['statusFinal'] =
      hoje <= inst.windowEnd ? 'DONE_ON_TIME' : 'DONE_LATE';

    const concluida = t
      .update(taskInstances)
      .set({ status: statusFinal, finishedAt: agora, executanteId: ator.id })
      .where(eq(taskInstances.id, inst.id))
      .returning()
      .get()!;

    let proxima: InstanciaRow | null = null;
    if (template.ativo && (template.triggerType === 'CALENDAR' || template.triggerType === 'HYBRID')) {
      // RESET TOTAL (§4.3 + revisão da Onda 03/S2): conclusão de instância de NAVIO reinicia
      // o relógio a partir de hoje, sempre — a âncora FIXED não deriva de data de navio.
      const due =
        template.scheduleMode === 'FLOATING' || inst.origin === 'SHIP'
          ? somarDias(hoje, template.intervalDays)
          : proximaAncoraFixed(template, inst.dueDate, hoje);
      proxima = criarInstancia(t, template, { due });
    }

    audit(t, {
      ator,
      acao: 'INSTANCIA_CONCLUIDA',
      entidade: 'task_instances',
      entidadeId: inst.id,
      antes: { status: inst.status, dueDate: inst.dueDate, windowEnd: inst.windowEnd },
      depois: { status: statusFinal, proximaDue: proxima?.dueDate ?? null },
      ip,
    });

    return { concluida, statusFinal, proxima };
  });
}

export type DadosJustificativa = {
  motivo: MotivoJustificativa;
  texto?: string | null;
  fotoId?: number | null;
};

export type ResultadoJustificativa = {
  justificada: InstanciaRow;
  justificativaId: number;
  proxima: InstanciaRow | null;
};

/**
 * Justificar = conclusão SEM execução — pertence ao 1º ponto do motor (o agendamento
 * continua vivendo em exatamente 3 pontos; leitura registrada no ESTADO da Onda 05).
 * Transacional: fecha como MISSED (justificável, alimenta o score na Onda 08), grava a
 * justificativa PENDENTE e reagenda a próxima para hoje + adiamento do MOTIVO — o
 * impedimento manda na data, não a âncora (mesmo racional do reset total da SHIP).
 */
export function onJustify(
  db: Db,
  instanciaId: number,
  dados: DadosJustificativa,
  ator: Ator,
  agora: Date,
  ip?: string,
): ResultadoJustificativa {
  return db.transaction((tx) => {
    const t = tx as unknown as Db;

    const inst = t.select().from(taskInstances).where(eq(taskInstances.id, instanciaId)).get();
    if (!inst) {
      throw new ConclusaoInvalidaError('Instância não encontrada.');
    }
    if (!(STATUS_ABERTOS as readonly string[]).includes(inst.status)) {
      throw new ConclusaoInvalidaError('Instância já fechada — nada para justificar.');
    }

    const template = t
      .select()
      .from(taskTemplates)
      .where(eq(taskTemplates.id, inst.templateId))
      .get()!;

    const justificada = t
      .update(taskInstances)
      .set({ status: 'MISSED', finishedAt: agora })
      .where(eq(taskInstances.id, inst.id))
      .returning()
      .get()!;

    const justificativa = t
      .insert(justificativas)
      .values({
        instanceId: inst.id,
        motivo: dados.motivo,
        texto: dados.texto ?? null,
        fotoId: dados.fotoId ?? null,
        criadoPorId: ator.id,
      })
      .returning()
      .get()!;

    let proxima: InstanciaRow | null = null;
    if (template.ativo && (template.triggerType === 'CALENDAR' || template.triggerType === 'HYBRID')) {
      const due = somarDias(dataRecife(agora), ADIAMENTO_POR_MOTIVO[dados.motivo]);
      proxima = criarInstancia(t, template, { due });
    }

    audit(t, {
      ator,
      acao: 'INSTANCIA_JUSTIFICADA',
      entidade: 'task_instances',
      entidadeId: inst.id,
      antes: { status: inst.status, dueDate: inst.dueDate },
      depois: {
        status: 'MISSED',
        motivo: dados.motivo,
        justificativaId: justificativa.id,
        proximaDue: proxima?.dueDate ?? null,
      },
      ip,
    });

    return { justificada, justificativaId: justificativa.id, proxima };
  });
}

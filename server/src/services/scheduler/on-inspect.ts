import { eq } from 'drizzle-orm';
import {
  dataRecife,
  PRAZO_RETRABALHO_DIAS,
  somarDias,
  type MotivoReprovacao,
  type Severidade,
} from '@rhodes/shared';

import type { Db } from '../../db/index.js';
import { inspections, taskInstances, taskTemplates } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { abertaDoTemplate, criarInstancia, type InstanciaRow } from './instancias.js';
import type { Ator } from './on-complete.js';

// REGRA DO MÓDULO (Onda 03): determinismo — `agora` SEMPRE chega de fora.

export class InspecaoInvalidaError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'InspecaoInvalidaError';
  }
}

/** Segregação de funções (imutável 1): quem executou não vistoria — nem sendo GESTOR. */
export class SegregacaoError extends Error {
  constructor() {
    super('Você executou esta tarefa — outra pessoa precisa vistoriá-la.');
    this.name = 'SegregacaoError';
  }
}

export type InspecaoRow = typeof inspections.$inferSelect;

export type DadosInspecao =
  | { resultado: 'APROVADA'; amostral?: boolean }
  | {
      resultado: 'REPROVADA';
      motivo: MotivoReprovacao;
      severidade: Severidade;
      texto?: string | null;
      fotoId?: number | null;
      amostral?: boolean;
    };

export type ResultadoInspecao = { inspecao: InspecaoRow; retrabalho: InstanciaRow | null };

/**
 * Vistoria como desdobramento da conclusão (decisão da onda: SEM 4º ponto de agendamento).
 * Reprovar gera retrabalho pelo padrão whichever-comes-first do motor: a próxima ocorrência
 * ABERTA do template é ANTECIPADA para min(due atual, hoje + prazo da severidade) e marcada
 * como retrabalho — nunca se cria uma 2ª aberta (o índice único parcial continua sendo a
 * trava física). Sem aberta (template inativo/SHIP puro), cria-se a instância do retrabalho.
 */
export function onInspect(
  db: Db,
  instanciaId: number,
  dados: DadosInspecao,
  ator: Ator,
  agora: Date,
  ip?: string,
): ResultadoInspecao {
  return db.transaction((tx) => {
    const t = tx as unknown as Db;

    const inst = t.select().from(taskInstances).where(eq(taskInstances.id, instanciaId)).get();
    if (!inst) {
      throw new InspecaoInvalidaError('Execução não encontrada.');
    }
    if (inst.status !== 'DONE_ON_TIME' && inst.status !== 'DONE_LATE') {
      throw new InspecaoInvalidaError('Só execuções concluídas passam por vistoria.');
    }
    if (inst.executanteId === ator.id) {
      throw new SegregacaoError();
    }
    const existente = t.select().from(inspections).where(eq(inspections.instanceId, inst.id)).get();
    if (existente) {
      throw new InspecaoInvalidaError('Esta execução já foi vistoriada.');
    }

    let retrabalho: InstanciaRow | null = null;
    if (dados.resultado === 'REPROVADA') {
      const template = t
        .select()
        .from(taskTemplates)
        .where(eq(taskTemplates.id, inst.templateId))
        .get()!;
      const alvo = somarDias(dataRecife(agora), PRAZO_RETRABALHO_DIAS[dados.severidade]);
      const aberta = abertaDoTemplate(t, inst.templateId);
      if (aberta) {
        // min(due, alvo): o retrabalho nunca ADIA uma ocorrência que já vence antes
        const due = aberta.dueDate <= alvo ? aberta.dueDate : alvo;
        retrabalho = t
          .update(taskInstances)
          .set({
            dueDate: due,
            windowEnd: somarDias(due, template.graceDays),
            reworkOfInstanceId: inst.id,
          })
          .where(eq(taskInstances.id, aberta.id))
          .returning()
          .get()!;
      } else {
        const criada = criarInstancia(t, template, { due: alvo });
        retrabalho = t
          .update(taskInstances)
          .set({ reworkOfInstanceId: inst.id })
          .where(eq(taskInstances.id, criada.id))
          .returning()
          .get()!;
      }
    }

    const inspecao = t
      .insert(inspections)
      .values({
        instanceId: inst.id,
        resultado: dados.resultado,
        vistoriadorId: ator.id,
        motivo: dados.resultado === 'REPROVADA' ? dados.motivo : null,
        severidade: dados.resultado === 'REPROVADA' ? dados.severidade : null,
        texto: dados.resultado === 'REPROVADA' ? (dados.texto ?? null) : null,
        fotoId: dados.resultado === 'REPROVADA' ? (dados.fotoId ?? null) : null,
        amostral: dados.amostral ?? false,
        retrabalhoInstanceId: retrabalho?.id ?? null,
      })
      .returning()
      .get()!;

    audit(t, {
      ator,
      acao: dados.resultado === 'APROVADA' ? 'EXECUCAO_APROVADA' : 'EXECUCAO_REPROVADA',
      entidade: 'task_instances',
      entidadeId: inst.id,
      antes: { status: inst.status },
      depois: {
        inspecaoId: inspecao.id,
        resultado: dados.resultado,
        motivo: dados.resultado === 'REPROVADA' ? dados.motivo : undefined,
        severidade: dados.resultado === 'REPROVADA' ? dados.severidade : undefined,
        amostral: inspecao.amostral,
        retrabalhoInstanceId: retrabalho?.id ?? null,
        retrabalhoDue: retrabalho?.dueDate ?? null,
      },
      ip,
    });

    return { inspecao, retrabalho };
  });
}

import { and, eq, gte, inArray, lt, lte } from 'drizzle-orm';
import { dataRecife, somarDias, STATUS_ABERTOS, type Classificacao, type EntradaScore } from '@rhodes/shared';

import type { Db } from '../../db/index.js';
import { areas, inspections, justificativas, taskInstances, taskTemplates } from '../../db/schema.js';
import { demeritosConfirmadosNaJanela } from './demeritos.js';

/**
 * Monta os eventos brutos da janela para a engine (S1), com o EIXO DE JANELA por componente
 * (decisões do ESTADO da Onda 08):
 * - Pontualidade/Cobertura filtram por `dueDate`;
 * - Aprovação e deméritos por `dataRecife(inspection.criadoEm)` (o dia da vistoria);
 * - tudo em dia operacional America/Recife.
 * A janela de N dias termina em `agora` e cobre [hoje − N, hoje].
 */
export function coletarEventos(db: Db, janelaDias: number, agora: Date): EntradaScore {
  const hoje = dataRecife(agora);
  const inicio = somarDias(hoje, -janelaDias);

  // Instâncias cujo dueDate cai na janela (pontualidade), com justificativa anexada.
  const instRows = db
    .select({
      templateId: taskInstances.templateId,
      areaId: taskTemplates.areaId,
      frequenciaDias: taskTemplates.intervalDays,
      dueDate: taskInstances.dueDate,
      finishedAt: taskInstances.finishedAt,
      status: taskInstances.status,
      origin: taskInstances.origin,
      executanteId: taskInstances.executanteId,
      jClassificacao: justificativas.classificacao,
      jStatus: justificativas.status,
    })
    .from(taskInstances)
    .innerJoin(taskTemplates, eq(taskInstances.templateId, taskTemplates.id))
    .leftJoin(justificativas, eq(justificativas.instanceId, taskInstances.id))
    .where(and(gte(taskInstances.dueDate, inicio), lte(taskInstances.dueDate, hoje)))
    .all();

  const instancias: EntradaScore['instancias'] = instRows.map((r) => ({
    templateId: r.templateId,
    areaId: r.areaId,
    frequenciaDias: r.frequenciaDias,
    dueDate: r.dueDate,
    finishedAt: r.finishedAt,
    status: r.status as EntradaScore['instancias'][number]['status'],
    origin: r.origin,
    executanteId: r.executanteId,
    justificativa: r.jStatus
      ? { classificacao: r.jClassificacao as Classificacao | null, status: r.jStatus }
      : undefined,
  }));

  // Inspeções de 1ª passagem (retrabalho fora) cuja data da vistoria cai na janela.
  const inspRows = db
    .select({
      areaId: taskTemplates.areaId,
      resultado: inspections.resultado,
      reworkOf: taskInstances.reworkOfInstanceId,
      criadoEm: inspections.criadoEm,
    })
    .from(inspections)
    .innerJoin(taskInstances, eq(inspections.instanceId, taskInstances.id))
    .innerJoin(taskTemplates, eq(taskInstances.templateId, taskTemplates.id))
    .all();

  const inspecoes: EntradaScore['inspecoes'] = inspRows
    .map((r) => ({
      areaId: r.areaId,
      resultado: r.resultado as EntradaScore['inspecoes'][number]['resultado'],
      primeiraVistoria: r.reworkOf === null,
      dataRecife: dataRecife(r.criadoEm),
    }))
    .filter((i) => i.dataRecife >= inicio && i.dataRecife <= hoje);

  // Cobertura (snapshot no fim): templates ativos e os que têm instância vencida aberta hoje.
  const templatesAtivos = db
    .select({ templateId: taskTemplates.id, areaId: taskTemplates.areaId })
    .from(taskTemplates)
    .where(eq(taskTemplates.ativo, true))
    .all();

  // "Vencida aberta" = instância aberta cuja janela dos 10% já fechou (windowEnd < hoje) —
  // mesma condição que define OVERDUE, recomputada do evento (não do status materializado).
  const vencidas = db
    .select({ templateId: taskInstances.templateId })
    .from(taskInstances)
    .where(and(inArray(taskInstances.status, [...STATUS_ABERTOS]), lt(taskInstances.windowEnd, hoje)))
    .all();
  const templatesComVencidaAberta = new Set(vencidas.map((v) => v.templateId));

  const areasRows = db.select({ areaId: areas.id, nome: areas.nome, peso: areas.pesoCriticidade }).from(areas).all();

  return {
    instancias,
    inspecoes,
    demeritos: demeritosConfirmadosNaJanela(db, inicio, hoje),
    templatesAtivos,
    templatesComVencidaAberta,
    areas: areasRows,
  };
}

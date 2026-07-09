import { and, eq, gte, inArray, lt, lte } from 'drizzle-orm';
import { dataRecife, somarDias, STATUS_ABERTOS, type Classificacao, type EntradaScore } from '@rhodes/shared';

import type { Db } from '../../db/index.js';
import { areas, inspections, justificativas, taskInstances, taskTemplates } from '../../db/schema.js';
import { demeritosConfirmadosNaJanela } from './demeritos.js';

/**
 * Monta os eventos brutos de uma JANELA FIXA de N dias terminando em `agora` (score da rota, Onda
 * 08). Fina casca sobre `coletarEventosEntre` — com `fim === hoje` e SEM escopo de área o resultado
 * é idêntico ao da Onda 08 (compat 1:1, coberto por teste).
 */
export function coletarEventos(db: Db, janelaDias: number, agora: Date): EntradaScore {
  const hoje = dataRecife(agora);
  return coletarEventosEntre(db, somarDias(hoje, -janelaDias), hoje);
}

/**
 * Monta os eventos brutos de um PERÍODO EXPLÍCITO [inicio, fim] (YYYY-MM-DD, America/Recife) para a
 * engine (S1 da Onda 09 — score do período do dossiê), com o EIXO DE JANELA por componente
 * (decisões do ESTADO da Onda 08):
 * - Pontualidade/Cobertura filtram por `dueDate`;
 * - Aprovação e deméritos por `dataRecife(inspection.criadoEm)` (o dia da vistoria);
 * - tudo em dia operacional America/Recife.
 * `areaIds` (opcional, Onda 09) ESCOPA todos os componentes às áreas dadas — o dossiê filtrado por
 * área mostra um score coerente com suas páginas/conformidade. Sem `areaIds` (ou vazio) o caminho é
 * BYTE-IDÊNTICO ao da Onda 08 (nenhum join/where extra).
 * NOTA: a Cobertura ("vencida aberta") é um SNAPSHOT do estado ABERTO ATUAL (status materializado
 * agora) com limiar `windowEnd < fim` — para um período histórico ela reflete hoje, não o `fim`.
 */
export function coletarEventosEntre(
  db: Db,
  inicio: string,
  fim: string,
  areaIds?: number[],
): EntradaScore {
  const escopoArea = areaIds && areaIds.length > 0 ? new Set(areaIds) : null;
  const filtroArea = escopoArea ? inArray(taskTemplates.areaId, [...escopoArea]) : undefined;

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
    .where(and(gte(taskInstances.dueDate, inicio), lte(taskInstances.dueDate, fim), filtroArea))
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
  const inspBase = db
    .select({
      areaId: taskTemplates.areaId,
      resultado: inspections.resultado,
      reworkOf: taskInstances.reworkOfInstanceId,
      criadoEm: inspections.criadoEm,
    })
    .from(inspections)
    .innerJoin(taskInstances, eq(inspections.instanceId, taskInstances.id))
    .innerJoin(taskTemplates, eq(taskInstances.templateId, taskTemplates.id));
  const inspRows = (filtroArea ? inspBase.where(filtroArea) : inspBase).all();

  const inspecoes: EntradaScore['inspecoes'] = inspRows
    .map((r) => ({
      areaId: r.areaId,
      resultado: r.resultado as EntradaScore['inspecoes'][number]['resultado'],
      primeiraVistoria: r.reworkOf === null,
      dataRecife: dataRecife(r.criadoEm),
    }))
    .filter((i) => i.dataRecife >= inicio && i.dataRecife <= fim);

  // Cobertura (snapshot no fim): templates ativos e os que têm instância vencida aberta hoje.
  const templatesAtivos = db
    .select({ templateId: taskTemplates.id, areaId: taskTemplates.areaId })
    .from(taskTemplates)
    .where(and(eq(taskTemplates.ativo, true), filtroArea))
    .all();

  // "Vencida aberta" = instância aberta cuja janela dos 10% já fechou (windowEnd < fim) —
  // mesma condição que define OVERDUE, recomputada do evento (não do status materializado).
  const vencidas = escopoArea
    ? db
        .select({ templateId: taskInstances.templateId })
        .from(taskInstances)
        .innerJoin(taskTemplates, eq(taskInstances.templateId, taskTemplates.id))
        .where(
          and(inArray(taskInstances.status, [...STATUS_ABERTOS]), lt(taskInstances.windowEnd, fim), filtroArea),
        )
        .all()
    : db
        .select({ templateId: taskInstances.templateId })
        .from(taskInstances)
        .where(and(inArray(taskInstances.status, [...STATUS_ABERTOS]), lt(taskInstances.windowEnd, fim)))
        .all();
  const templatesComVencidaAberta = new Set(vencidas.map((v) => v.templateId));

  const areasRows = db
    .select({ areaId: areas.id, nome: areas.nome, peso: areas.pesoCriticidade })
    .from(areas)
    .all()
    .filter((a) => !escopoArea || escopoArea.has(a.areaId));

  const demeritos = demeritosConfirmadosNaJanela(db, inicio, fim).filter(
    (d) => !escopoArea || escopoArea.has(d.areaId),
  );

  return {
    instancias,
    inspecoes,
    demeritos,
    templatesAtivos,
    templatesComVencidaAberta,
    areas: areasRows,
  };
}

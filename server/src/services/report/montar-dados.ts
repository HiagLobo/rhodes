import { and, asc, eq, gte, inArray, lte, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import {
  dataRecife,
  type ConformidadeArea,
  type ConformidadeClasse,
  type DossieDados,
  type EvidenciaPagina,
  type FotoEvidenciaDossie,
  type InstanceStatus,
  type JustificativaAnexo,
  type JustificativaStatus,
  type RelatorioFiltros,
} from '@rhodes/shared';

import type { Db } from '../../db/index.js';
import {
  areas,
  inspections,
  justificativas,
  metodoVersoes,
  photos,
  shipOperations,
  taskInstances,
  taskTemplates,
  users,
} from '../../db/schema.js';
import { tempoPorPartes } from '../scheduler/validar-evidencia.js';
import { coletarEventosEntre } from '../score/coletar.js';
import { lerScoreConfig } from '../score/config.js';
import { calcularScore } from '../score/engine.js';
import { hashCanonico } from './hash-canonico.js';

/**
 * Classifica uma instância nos baldes de conformidade do dossiê (Onda 09). Mapa PURO sobre os 6
 * INSTANCE_STATUS: os 3 estados FECHADOS (DONE_ON_TIME/DONE_LATE/MISSED) viram no-prazo/atrasada/
 * (justificada|perdida); os ABERTOS caem em EM_ABERTO (transparência do denominador).
 */
export function classificarConformidade(
  status: InstanceStatus,
  justificativaAprovada: boolean,
): ConformidadeClasse {
  switch (status) {
    case 'DONE_ON_TIME':
      return 'NO_PRAZO';
    case 'DONE_LATE':
      return 'ATRASADA';
    case 'MISSED':
      return justificativaAprovada ? 'JUSTIFICADA' : 'PERDIDA';
    default:
      return 'EM_ABERTO'; // PENDING | IN_PROGRESS | OVERDUE
  }
}

/**
 * Camada de dados do dossiê (Onda 09/S1): monta EM LOTE — ≤1 SELECT por tabela, filtrando as
 * tabelas-filhas por JOIN em `task_instances` no MESMO range de `dueDate` (nada de `IN(lista de
 * ids)` — evita o teto de variáveis do SQLite em 6 meses) — todo o conteúdo probatório do relatório.
 * `agora` é INJETADO (ALCOA: instante do servidor, nunca `new Date()` interno). Puro em relação a
 * efeitos: só LÊ o banco. O PDF (S2) e a rota (S3) consomem o `DossieDados`; o `path` da foto NUNCA
 * sai daqui (é resolvido server-side na S3).
 */
export function montarDossieDados(db: Db, filtros: RelatorioFiltros, agora: Date): DossieDados {
  const { inicio, fim } = filtros;

  // Predicado do período (∩ áreas ∩ rodada) — reutilizado nas 4 leituras (todas juntam
  // task_instances + task_templates, então as colunas referenciadas resolvem em cada query).
  const condicoes: (SQL | undefined)[] = [
    gte(taskInstances.dueDate, inicio),
    lte(taskInstances.dueDate, fim),
    filtros.areaIds && filtros.areaIds.length > 0
      ? inArray(taskTemplates.areaId, filtros.areaIds)
      : undefined,
    filtros.roundId ? eq(taskInstances.roundId, filtros.roundId) : undefined,
  ];
  const where = and(...condicoes);

  // 1) Instâncias do período (com área, template, executante).
  const instRows = db
    .select({
      id: taskInstances.id,
      dueDate: taskInstances.dueDate,
      windowEnd: taskInstances.windowEnd,
      status: taskInstances.status,
      finishedAt: taskInstances.finishedAt,
      roundId: taskInstances.roundId,
      executanteLogin: users.login,
      areaId: areas.id,
      areaNome: areas.nome,
      atividade: taskTemplates.atividade,
      frequency: taskTemplates.frequency,
      intervalDays: taskTemplates.intervalDays,
      metodoVersaoAtualId: taskTemplates.metodoVersaoAtualId,
    })
    .from(taskInstances)
    .innerJoin(taskTemplates, eq(taskInstances.templateId, taskTemplates.id))
    .innerJoin(areas, eq(taskTemplates.areaId, areas.id))
    .leftJoin(users, eq(taskInstances.executanteId, users.id))
    .where(where)
    .orderBy(asc(areas.nome), asc(taskInstances.dueDate), asc(taskInstances.id))
    .all();

  // 2) Fotos das instâncias do período (agrupadas por instância; sem N+1, sem IN(ids)).
  const fotoRows = db
    .select({ foto: photos })
    .from(photos)
    .innerJoin(taskInstances, eq(photos.instanceId, taskInstances.id))
    .innerJoin(taskTemplates, eq(taskInstances.templateId, taskTemplates.id))
    .where(where)
    .orderBy(asc(photos.instanceId), asc(photos.id))
    .all();
  const fotosPorInstancia = new Map<number, (typeof fotoRows)[number]['foto'][]>();
  for (const r of fotoRows) {
    const lista = fotosPorInstancia.get(r.foto.instanceId) ?? [];
    lista.push(r.foto);
    fotosPorInstancia.set(r.foto.instanceId, lista);
  }

  // 3) Inspeções POR INSTÂNCIA (inspections é UNIQUE por instância) — SEM filtro de retrabalho: a
  //    página de uma instância-retrabalho PRECISA da sua vistoria (prova do reprovado→retrabalho).
  const inspRows = db
    .select({ insp: inspections, vistoriador: users.login })
    .from(inspections)
    .innerJoin(taskInstances, eq(inspections.instanceId, taskInstances.id))
    .innerJoin(taskTemplates, eq(taskInstances.templateId, taskTemplates.id))
    .innerJoin(users, eq(inspections.vistoriadorId, users.id))
    .where(where)
    .all();
  const inspPorInstancia = new Map<number, (typeof inspRows)[number]>();
  for (const r of inspRows) inspPorInstancia.set(r.insp.instanceId, r);

  // 4) Justificativas das instâncias do período (anexo + flag de conformidade).
  const decisor = alias(users, 'decisor');
  const justRows = db
    .select({
      j: justificativas,
      areaNome: areas.nome,
      atividade: taskTemplates.atividade,
      decididoPor: decisor.login,
    })
    .from(justificativas)
    .innerJoin(taskInstances, eq(justificativas.instanceId, taskInstances.id))
    .innerJoin(taskTemplates, eq(taskInstances.templateId, taskTemplates.id))
    .innerJoin(areas, eq(taskTemplates.areaId, areas.id))
    .leftJoin(decisor, eq(justificativas.decididoPorId, decisor.id))
    .where(where)
    .all();
  const justPorInstancia = new Map<number, (typeof justRows)[number]>();
  for (const r of justRows) justPorInstancia.set(r.j.instanceId, r);

  // 5) Navio/lote das rodadas presentes (roundId é pequeno: nº de rodadas, não de instâncias).
  const roundIds = [
    ...new Set(instRows.map((r) => r.roundId).filter((x): x is number => x !== null)),
  ];
  const shipRows = roundIds.length
    ? db.select().from(shipOperations).where(inArray(shipOperations.id, roundIds)).all()
    : [];
  const shipPorId = new Map(shipRows.map((s) => [s.id, s]));

  // 6) POP vigente (texto da versão atual do template) das versões presentes.
  const metodoIds = [
    ...new Set(instRows.map((r) => r.metodoVersaoAtualId).filter((x): x is number => x !== null)),
  ];
  const metodoRows = metodoIds.length
    ? db
        .select({ id: metodoVersoes.id, texto: metodoVersoes.texto })
        .from(metodoVersoes)
        .where(inArray(metodoVersoes.id, metodoIds))
        .all()
    : [];
  const metodoPorId = new Map(metodoRows.map((m) => [m.id, m.texto]));

  // Monta as páginas (todas as instâncias do período; a filtragem por reprovadas é aplicada depois).
  const paginas: EvidenciaPagina[] = instRows.map((r) => {
    const fotosRaw = fotosPorInstancia.get(r.id) ?? [];
    const insp = inspPorInstancia.get(r.id);
    const just = justPorInstancia.get(r.id);
    const ship = r.roundId !== null ? shipPorId.get(r.roundId) : undefined;
    return {
      instanceId: r.id,
      areaId: r.areaId,
      areaNome: r.areaNome,
      atividade: r.atividade,
      frequency: r.frequency,
      intervalDays: r.intervalDays,
      dueDate: r.dueDate,
      windowEnd: r.windowEnd,
      statusFinal: r.status as InstanceStatus,
      conformidade: classificarConformidade(r.status as InstanceStatus, just?.j.status === 'APROVADA'),
      executante: r.executanteLogin,
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      tempoExecucaoSeg: tempoPorPartes(
        fotosRaw.map((f) => ({ tipo: f.tipo, parte: f.parte, receivedAt: f.receivedAt })),
      ),
      metodoVersao:
        r.metodoVersaoAtualId !== null ? metodoPorId.get(r.metodoVersaoAtualId) ?? null : null,
      fotos: fotosRaw.map(paraFotoEvidencia),
      inspecao: insp
        ? {
            resultado: insp.insp.resultado,
            vistoriador: insp.vistoriador,
            criadoEm: insp.insp.criadoEm.toISOString(),
            severidade: insp.insp.severidade,
            motivo: insp.insp.motivo,
            texto: insp.insp.texto,
            amostral: insp.insp.amostral,
          }
        : null,
      navioLote: ship
        ? {
            roundId: ship.id,
            navio: ship.navio,
            produto: ship.produto,
            tonelagem: ship.tonelagem,
            etaDate: ship.etaDate,
          }
        : null,
    };
  });

  // Tabela de conformidade — reflete o PERÍODO INTEIRO (todas as instâncias), independente do
  // filtro de "só reprovadas" (que estreita só as páginas de evidência).
  const confPorArea = new Map<number, ConformidadeArea>();
  for (const p of paginas) {
    let c = confPorArea.get(p.areaId);
    if (!c) {
      c = {
        areaId: p.areaId,
        areaNome: p.areaNome,
        noPrazo: 0,
        atrasadas: 0,
        justificadas: 0,
        perdidas: 0,
        emAberto: 0,
        total: 0,
      };
      confPorArea.set(p.areaId, c);
    }
    c.total += 1;
    if (p.conformidade === 'NO_PRAZO') c.noPrazo += 1;
    else if (p.conformidade === 'ATRASADA') c.atrasadas += 1;
    else if (p.conformidade === 'JUSTIFICADA') c.justificadas += 1;
    else if (p.conformidade === 'PERDIDA') c.perdidas += 1;
    else c.emAberto += 1;
  }
  const conformidade = [...confPorArea.values()].sort((a, b) => a.areaNome.localeCompare(b.areaNome));

  const anexoJustificativas: JustificativaAnexo[] = justRows
    .map((r) => ({
      areaNome: r.areaNome,
      atividade: r.atividade,
      motivo: r.j.motivo,
      texto: r.j.texto,
      status: r.j.status as JustificativaStatus,
      criadoEm: r.j.criadoEm.toISOString(),
      decididoPor: r.decididoPor,
    }))
    .sort((a, b) => a.areaNome.localeCompare(b.areaNome) || a.atividade.localeCompare(b.atividade));

  const responsaveisSet = new Set<string>();
  for (const r of instRows) if (r.executanteLogin) responsaveisSet.add(r.executanteLogin);
  for (const r of inspRows) if (r.vistoriador) responsaveisSet.add(r.vistoriador);
  const responsaveis = [...responsaveisSet].sort();

  const areasPresentes = db
    .select({ id: areas.id, nome: areas.nome, peso: areas.pesoCriticidade })
    .from(areas)
    .where(
      confPorArea.size > 0 ? inArray(areas.id, [...confPorArea.keys()]) : eq(areas.id, -1),
    )
    .orderBy(asc(areas.nome))
    .all();

  // Score ESCOPADO pelas mesmas áreas do filtro (coerente com páginas/conformidade); NÃO por
  // roundId (o score não é métrica de rodada — ver DossieDados.score).
  const score = calcularScore(
    coletarEventosEntre(db, inicio, fim, filtros.areaIds),
    lerScoreConfig(db),
  );

  const paginasFiltradas = filtros.somenteReprovadasOuCriticas
    ? paginas.filter(
        (p) => p.inspecao?.resultado === 'REPROVADA' || p.inspecao?.severidade === 'CRITICA',
      )
    : paginas;

  const parcial: Omit<DossieDados, 'hash'> = {
    periodo: { inicio, fim },
    geradoEm: agora.toISOString(),
    responsaveis,
    areas: areasPresentes,
    score,
    coberturaSnapshot: fim < dataRecife(agora),
    conformidade,
    paginas: paginasFiltradas,
    justificativas: anexoJustificativas,
  };
  return { ...parcial, hash: hashCanonico(parcial, filtros) };
}

function paraFotoEvidencia(f: {
  id: number;
  tipo: string;
  parte: number;
  sha256: string;
  receivedAt: Date;
  capturedAt: Date;
  skewMs: number;
}): FotoEvidenciaDossie {
  return {
    id: f.id,
    tipo: f.tipo,
    parte: f.parte,
    sha256: f.sha256,
    receivedAt: f.receivedAt.toISOString(),
    capturedAt: f.capturedAt.toISOString(),
    skewMs: f.skewMs,
  };
}

import { createHash } from 'node:crypto';

import type { DossieDados, RelatorioFiltros } from '@rhodes/shared';

/**
 * Hash canônico dos dados PROBATÓRIOS do dossiê (Onda 09/S1). Função PURA e DETERMINÍSTICA: o mesmo
 * conteúdo probatório sempre gera o mesmo SHA-256; alterar QUALQUER campo IMPRESSO no dossiê — uma
 * foto (sha256/tipo/parte), um resultado/severidade/motivo/observação de vistoria, o vínculo
 * navio/lote (navio/produto/tonelagem/eta), o POP, uma justificativa, a conformidade, o score ou um
 * filtro — muda o hash. O `geradoEm` NÃO entra (senão o hash mudaria a cada geração e deixaria de
 * ser verificável). Impresso no rodapé do PDF e gravado no `audit_log` da geração (S3).
 *
 * A ordenação canônica (instâncias por id, fotos por sha256, conformidade/justificativas por chave
 * estável) neutraliza a ordem de leitura do banco; os objetos são montados em ordem FIXA de chaves
 * antes do JSON.stringify.
 */
export function hashCanonico(dados: Omit<DossieDados, 'hash'>, filtros: RelatorioFiltros): string {
  const canonico = {
    filtros: {
      inicio: filtros.inicio,
      fim: filtros.fim,
      // [] e ausente são o MESMO escopo (todas as áreas) — normalizados para o mesmo hash.
      areaIds:
        filtros.areaIds && filtros.areaIds.length > 0 ? [...filtros.areaIds].sort((a, b) => a - b) : null,
      roundId: filtros.roundId ?? null,
      somenteReprovadasOuCriticas: filtros.somenteReprovadasOuCriticas,
    },
    periodo: dados.periodo,
    coberturaSnapshot: dados.coberturaSnapshot,
    score: { score: dados.score.score, banda: dados.score.banda },
    conformidade: [...dados.conformidade]
      .sort((a, b) => a.areaId - b.areaId)
      .map((c) => ({
        areaId: c.areaId,
        noPrazo: c.noPrazo,
        atrasadas: c.atrasadas,
        justificadas: c.justificadas,
        perdidas: c.perdidas,
        emAberto: c.emAberto,
        total: c.total,
      })),
    instancias: [...dados.paginas]
      .sort((a, b) => a.instanceId - b.instanceId)
      .map((p) => ({
        id: p.instanceId,
        statusFinal: p.statusFinal,
        conformidade: p.conformidade,
        frequency: p.frequency,
        intervalDays: p.intervalDays,
        dueDate: p.dueDate,
        windowEnd: p.windowEnd,
        executante: p.executante,
        finishedAt: p.finishedAt,
        tempoExecucaoSeg: p.tempoExecucaoSeg,
        metodoVersao: p.metodoVersao,
        inspecao: p.inspecao
          ? {
              resultado: p.inspecao.resultado,
              vistoriador: p.inspecao.vistoriador,
              criadoEm: p.inspecao.criadoEm,
              severidade: p.inspecao.severidade,
              motivo: p.inspecao.motivo,
              texto: p.inspecao.texto,
              amostral: p.inspecao.amostral,
            }
          : null,
        navioLote: p.navioLote
          ? {
              roundId: p.navioLote.roundId,
              navio: p.navioLote.navio,
              produto: p.navioLote.produto,
              tonelagem: p.navioLote.tonelagem,
              etaDate: p.navioLote.etaDate,
            }
          : null,
        fotos: [...p.fotos]
          .map((f) => ({ sha256: f.sha256, tipo: f.tipo, parte: f.parte, receivedAt: f.receivedAt }))
          .sort((a, b) => a.sha256.localeCompare(b.sha256)),
      })),
    justificativas: [...dados.justificativas]
      .map((j) => ({
        areaNome: j.areaNome,
        atividade: j.atividade,
        motivo: j.motivo,
        texto: j.texto,
        status: j.status,
        criadoEm: j.criadoEm,
        decididoPor: j.decididoPor,
      }))
      .sort(
        (a, b) =>
          a.areaNome.localeCompare(b.areaNome) ||
          a.atividade.localeCompare(b.atividade) ||
          a.criadoEm.localeCompare(b.criadoEm),
      ),
  };
  return createHash('sha256').update(JSON.stringify(canonico)).digest('hex');
}

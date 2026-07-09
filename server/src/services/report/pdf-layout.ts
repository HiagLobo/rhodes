import type { DossieDados, EvidenciaPagina, FotoEvidenciaDossie } from '@rhodes/shared';

import type { ImagemExibicao } from './imagem-exibicao.js';

/** Cores das bandas SQF (o server não importa o theme do web — mapa local mínimo). */
const CORES_BANDA: Record<string, string> = {
  EXCELENTE: '#2f9e44',
  BOM: '#1971c2',
  ATENCAO: '#e8a90c',
  CRITICO: '#c92a2a',
};

const ROTULO_CONFORMIDADE: Record<string, string> = {
  NO_PRAZO: 'No prazo',
  ATRASADA: 'Atrasada',
  JUSTIFICADA: 'Justificada',
  PERDIDA: 'Perdida',
  EM_ABERTO: 'Em aberto',
};

type Doc = PDFKit.PDFDocument;

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function formatDuracao(seg: number | null): string {
  if (seg === null) return '—';
  const min = Math.round(seg / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}min`;
}

/** 'YYYY-MM-DDTHH:MM:SS.sssZ' → 'YYYY-MM-DD HH:MM' (hora do SERVIDOR, UTC). */
function dataHora(iso: string | null): string {
  return iso ? `${iso.replace('T', ' ').slice(0, 16)} UTC` : '—';
}

// ------------------------------------------------------------------------- capa

export function capa(doc: Doc, dados: DossieDados): void {
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#111827').text('Dossiê de Auditoria de Limpeza', { align: 'center' });
  doc.font('Helvetica').fontSize(11).fillColor('#4b5563').text('Rhodes S.A · Terminal de Graneis · Porto do Recife', { align: 'center' });
  doc.moveDown(1.5);

  doc.fontSize(11).fillColor('#111827');
  doc.text(`Período: ${dados.periodo.inicio} a ${dados.periodo.fim}`);
  doc.text(`Áreas: ${trunc(dados.areas.map((a) => a.nome).join(', ') || '—', 200)}`);

  const s = dados.score.score;
  if (s === null) {
    doc.text('Score do período: sem dados no escopo.');
  } else {
    const banda = dados.score.banda ?? 'CRITICO';
    doc.font('Helvetica-Bold').fillColor(CORES_BANDA[banda] ?? '#111827');
    doc.text(`Score do período: ${s.toFixed(1)} — ${banda}`);
    doc.font('Helvetica').fillColor('#111827');
  }
  if (dados.coberturaSnapshot) {
    doc.fontSize(8).fillColor('#c92a2a').text('Cobertura = snapshot atual (período histórico; não reconstruído ao fim).');
    doc.fontSize(11).fillColor('#111827');
  }
  doc.text(`Responsáveis: ${trunc(dados.responsaveis.join(', ') || '—', 200)}`);

  doc.moveDown(1);
  doc.fontSize(8).fillColor('#6b7280').text(`Integridade (SHA-256): ${dados.hash}`);
  doc.fontSize(8).text('O score é do período no escopo de áreas do filtro (não estreitado por rodada de navio).');
  doc.fillColor('#111827');
}

// ------------------------------------------------------- tabela de conformidade

export function tabelaConformidade(doc: Doc, dados: DossieDados): void {
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#111827').text('Conformidade por área');
  doc.moveDown(0.5);

  const left = doc.page.margins.left;
  const xs = [left, left + 175, left + 240, left + 305, left + 360, left + 420, left + 480];
  const cab = ['Área', 'No prazo', 'Atrasadas', 'Justif.', 'Perdidas', 'Em aberto', 'Total'];

  const desenharCabecalho = (): void => {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#111827');
    cab.forEach((c, i) => doc.text(c, xs[i]!, y, { width: 60, lineBreak: false }));
    doc.moveTo(left, y + 12).lineTo(doc.page.width - doc.page.margins.right, y + 12).strokeColor('#cbd5e1').stroke();
    doc.y = y + 16;
  };
  desenharCabecalho();

  const tot = { noPrazo: 0, atrasadas: 0, justificadas: 0, perdidas: 0, emAberto: 0, total: 0 };
  doc.font('Helvetica').fontSize(9).fillColor('#111827');
  for (const c of dados.conformidade) {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 24) {
      doc.addPage();
      desenharCabecalho();
      doc.font('Helvetica').fontSize(9).fillColor('#111827');
    }
    const y = doc.y;
    const cells = [trunc(c.areaNome, 28), c.noPrazo, c.atrasadas, c.justificadas, c.perdidas, c.emAberto, c.total];
    cells.forEach((v, i) => doc.text(String(v), xs[i]!, y, { width: 60, lineBreak: false }));
    tot.noPrazo += c.noPrazo;
    tot.atrasadas += c.atrasadas;
    tot.justificadas += c.justificadas;
    tot.perdidas += c.perdidas;
    tot.emAberto += c.emAberto;
    tot.total += c.total;
    doc.y = y + 14;
  }

  if (doc.y + 24 > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
    desenharCabecalho();
    doc.font('Helvetica').fontSize(9).fillColor('#111827');
  }
  const y = doc.y + 2;
  doc.moveTo(left, y).lineTo(doc.page.width - doc.page.margins.right, y).strokeColor('#cbd5e1').stroke();
  doc.font('Helvetica-Bold').fontSize(9);
  const totCells = ['Total geral', tot.noPrazo, tot.atrasadas, tot.justificadas, tot.perdidas, tot.emAberto, tot.total];
  totCells.forEach((v, i) => doc.text(String(v), xs[i]!, y + 4, { width: 60, lineBreak: false }));
  doc.font('Helvetica').fillColor('#111827');
}

// ------------------------------------------------------- página de evidência

export type GrupoParte = {
  parte: number;
  antes: FotoEvidenciaDossie[];
  depois: FotoEvidenciaDossie[];
  outras: FotoEvidenciaDossie[];
};

/**
 * Agrupa as fotos POR PARTE (ordinal de execução multi-dia) e, dentro da parte, por tipo. O
 * pareamento ANTES↔DEPOIS do dossiê usa isto — nunca o índice do array, que depende da ordem de
 * `photos.id` e embaralharia os pares em atividades multi-parte / reenvio. Função pura (testável).
 */
export function agruparFotosPorParte(fotos: FotoEvidenciaDossie[]): GrupoParte[] {
  const partes = [...new Set(fotos.map((f) => f.parte))].sort((a, b) => a - b);
  return partes.map((parte) => {
    const doParte = fotos.filter((f) => f.parte === parte);
    return {
      parte,
      antes: doParte.filter((f) => f.tipo === 'ANTES'),
      depois: doParte.filter((f) => f.tipo === 'DEPOIS'),
      outras: doParte.filter((f) => f.tipo !== 'ANTES' && f.tipo !== 'DEPOIS'),
    };
  });
}

function legenda(doc: Doc, f: FotoEvidenciaDossie, x: number, y: number, largura: number): void {
  doc.font('Helvetica').fontSize(7).fillColor('#4b5563');
  doc.text(`${f.tipo} · ${dataHora(f.receivedAt)} · sha ${f.sha256.slice(0, 10)}…`, x, y, {
    width: largura,
    lineBreak: false,
  });
  doc.fillColor('#111827');
}

export async function paginaEvidencia(
  doc: Doc,
  p: EvidenciaPagina,
  carregarImagem: (foto: FotoEvidenciaDossie) => Promise<ImagemExibicao>,
  sha256Usados: string[],
  sha256Ausentes: string[],
): Promise<void> {
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#111827').text(`${p.areaNome} — ${trunc(p.atividade, 80)}`);
  doc.font('Helvetica').fontSize(9).fillColor('#374151');
  doc.text(
    `Frequência: cada ${p.intervalDays} dia(s) (${p.frequency}) · Vencimento: ${p.dueDate} · ` +
      `Situação: ${ROTULO_CONFORMIDADE[p.conformidade] ?? p.conformidade} (${p.statusFinal})`,
  );
  doc.text(
    `Executante: ${p.executante ?? '—'} · Concluído: ${dataHora(p.finishedAt)} · Duração: ${formatDuracao(p.tempoExecucaoSeg)}`,
  );
  if (p.navioLote) {
    doc.text(`Navio/lote: ${p.navioLote.navio} · ${p.navioLote.produto ?? '—'} · ETA ${p.navioLote.etaDate}`);
  }
  if (p.metodoVersao) doc.fontSize(8).fillColor('#6b7280').text(`POP (vigente): ${trunc(p.metodoVersao, 300)}`).fontSize(9).fillColor('#374151');
  doc.moveDown(0.5);

  const boxW = 235;
  const boxH = 165;
  const xEsq = doc.page.margins.left;
  const xDir = doc.page.margins.left + boxW + 20;

  const embutir = async (f: FotoEvidenciaDossie | undefined, x: number, yTop: number): Promise<void> => {
    if (!f) return;
    try {
      const { buffer, presente } = await carregarImagem(f);
      doc.image(buffer, x, yTop, { fit: [boxW, boxH], align: 'center', valign: 'center' });
      (presente ? sha256Usados : sha256Ausentes).push(f.sha256); // só conta como usada após embutir
    } catch {
      doc.font('Helvetica').fontSize(8).fillColor('#c92a2a').text('[imagem indisponível]', x, yTop + 70, { width: boxW, align: 'center' });
      doc.fillColor('#111827');
      sha256Ausentes.push(f.sha256);
    }
    legenda(doc, f, x, yTop + boxH + 2, boxW);
  };

  const linhaImagens = async (
    esq: FotoEvidenciaDossie | undefined,
    dir: FotoEvidenciaDossie | undefined,
  ): Promise<void> => {
    if (doc.y + boxH + 30 > doc.page.height - doc.page.margins.bottom) doc.addPage();
    const yTop = doc.y;
    await embutir(esq, xEsq, yTop);
    await embutir(dir, xDir, yTop);
    doc.y = yTop + boxH + 24;
    doc.x = doc.page.margins.left;
  };

  // Pareia ANTES|DEPOIS POR PARTE (não por índice de array): o vínculo probatório não pode depender
  // da ordem de photos.id (multi-dia/reenvio embaralharia os pares).
  for (const g of agruparFotosPorParte(p.fotos)) {
    const linhas = Math.max(g.antes.length, g.depois.length);
    for (let i = 0; i < linhas; i += 1) await linhaImagens(g.antes[i], g.depois[i]);
    for (const f of g.outras) await linhaImagens(f, undefined);
  }
  if (p.fotos.length === 0) {
    doc.font('Helvetica').fontSize(9).fillColor('#b45309').text('Sem evidência fotográfica.');
    doc.fillColor('#111827');
  }

  doc.moveDown(0.4).font('Helvetica').fontSize(9).fillColor('#111827');
  doc.text(`Concluído por ${p.executante ?? '—'} em ${dataHora(p.finishedAt)}.`);
  if (p.inspecao) {
    doc.text(
      `Verificado eletronicamente por ${p.inspecao.vistoriador} em ${dataHora(p.inspecao.criadoEm)} — ` +
        `${p.inspecao.resultado}${p.inspecao.amostral ? ' (amostral)' : ''}.`,
    );
    if (p.inspecao.resultado === 'REPROVADA') {
      const motivo = [p.inspecao.severidade, p.inspecao.motivo, p.inspecao.texto].filter(Boolean).join(' · ');
      if (motivo) doc.fillColor('#c92a2a').text(`Motivo da reprovação: ${trunc(motivo, 300)}`).fillColor('#111827');
    }
  } else {
    doc.fillColor('#6b7280').text('Sem vistoria registrada (a verificação é amostral).').fillColor('#111827');
  }
}

// ------------------------------------------------------- anexo de justificativas

export function anexoJustificativas(doc: Doc, dados: DossieDados): void {
  if (dados.justificativas.length === 0) return;
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#111827').text('Anexo — Justificativas do período');
  doc.moveDown(0.5);

  for (const j of dados.justificativas) {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 50) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#111827').text(`${j.areaNome} — ${trunc(j.atividade, 80)}`);
    doc.font('Helvetica').fontSize(9).fillColor('#374151').text(
      `Motivo: ${j.motivo} · Status: ${j.status}${j.decididoPor ? ` · por ${j.decididoPor}` : ''} · ${dataHora(j.criadoEm)}`,
    );
    if (j.texto) doc.fillColor('#6b7280').text(`Obs.: ${trunc(j.texto, 300)}`).fillColor('#374151');
    doc.moveDown(0.4);
  }
  doc.fillColor('#111827');
}

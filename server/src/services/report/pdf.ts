import { finished as streamFinished, type Writable } from 'node:stream';

import PDFDocument from 'pdfkit';
import type { DossieDados, FotoEvidenciaDossie } from '@rhodes/shared';

import type { ImagemExibicao } from './imagem-exibicao.js';
import { anexoJustificativas, capa, paginaEvidencia, tabelaConformidade } from './pdf-layout.js';

/**
 * Manifesto verificável do que o PDF de fato contém (ALCOA+ Exato): `sha256Usados` = fotos cujo
 * BINÁRIO real foi embutido; `sha256Ausentes` = fotos que caíram no placeholder (arquivo sumiu). A
 * S3 grava a distinção no audit_log — o dossiê não pode afirmar prova que não incluiu.
 */
export type ResumoRender = { paginasEvidencia: number; sha256Usados: string[]; sha256Ausentes: string[] };

export type CarregarImagem = (foto: FotoEvidenciaDossie) => Promise<ImagemExibicao>;

export type OpcoesPdf = {
  /** false no modo teste (texto ASCII fica legível no stream). Default true (produção). */
  comprimir?: boolean;
};

/** Restaura fonte/tamanho após desenhar o rodapé (o pdfkit não os restaura ao continuar um texto que quebrou de página). */
type EstadoFonte = { _font: unknown; _fontSize: number };

/**
 * Gera o dossiê em PDF (Onda 09/S2) ESCREVENDO em `destino` (streaming — `doc.pipe`, sem
 * `bufferPages`, sem segurar o PDF inteiro na heap). As fotos são resolvidas e embutidas UMA A UMA
 * (via `carregarImagem`, injetado pela S3 com o `path` do servidor) e liberadas a cada página. Usa a
 * Helvetica embutida do pdfkit (WinAnsi cobre os acentos do PT — sem TTF externa para copiar ao
 * dist). Rodapé "pág X" (número corrente, SEM total "X/Y" — o total exigiria `bufferPages`, que
 * estouraria a memória em 6 meses). Retorna o manifesto para verificação por teste (sem abrir o PDF).
 */
export async function gerarDossiePdf(
  dados: DossieDados,
  carregarImagem: CarregarImagem,
  destino: Writable,
  opcoes: OpcoesPdf = {},
): Promise<ResumoRender> {
  const doc = new PDFDocument({
    autoFirstPage: false,
    size: 'A4',
    margin: 40,
    compress: opcoes.comprimir ?? true,
    info: { Title: 'Dossie de Auditoria de Limpeza', Author: 'Rhodes S.A' },
  });

  const hashCurto = dados.hash.slice(0, 16);
  let numPagina = 0;
  let desenhandoRodape = false;
  doc.on('pageAdded', () => {
    if (desenhandoRodape) return; // re-entrância (o rodapé nunca dispara nova página)
    desenhandoRodape = true;
    numPagina += 1;
    // Preserva a fonte/tamanho do fluxo: se um texto quebrou de página, a continuação precisa manter
    // a fonte que estava ativa (o pdfkit reaplica x/fill em nextSection, mas NÃO fonte/tamanho).
    const est = doc as unknown as EstadoFonte;
    const fonteAntes = est._font;
    const tamanhoAntes = est._fontSize;

    const left = doc.page.margins.left;
    const largura = doc.page.width - left - doc.page.margins.right;
    const yRodape = doc.page.height - doc.page.margins.bottom + 8;
    doc.save();
    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor('#9ca3af')
      .text(`Relatório ${hashCurto}… · gerado em ${dados.geradoEm} · pág ${numPagina}`, left, yRodape, {
        width: largura,
        align: 'center',
        lineBreak: false,
      });
    doc.restore(); // restaura o estado gráfico (cor de preenchimento)

    est._font = fonteAntes;
    est._fontSize = tamanhoAntes;
    doc.x = left;
    doc.y = doc.page.margins.top;
    desenhandoRodape = false;
  });

  // `stream.finished` trata finish/close/error de forma unificada — em `reply.raw` o abort do cliente
  // emite 'close' (sem 'finish'), então sem isso o await ficaria pendente para sempre.
  const finalizado = new Promise<void>((resolve, reject) => {
    streamFinished(destino, (err) => (err ? reject(err) : resolve()));
    doc.on('error', reject);
  });
  doc.pipe(destino);

  const sha256Usados: string[] = [];
  const sha256Ausentes: string[] = [];
  try {
    capa(doc, dados);
    tabelaConformidade(doc, dados);
    for (const p of dados.paginas) {
      await paginaEvidencia(doc, p, carregarImagem, sha256Usados, sha256Ausentes);
    }
    anexoJustificativas(doc, dados);
    doc.end();
    await finalizado;
  } catch (err) {
    doc.destroy();
    if (!destino.destroyed) destino.destroy(err as Error);
    throw err;
  }
  return { paginasEvidencia: dados.paginas.length, sha256Usados, sha256Ausentes };
}

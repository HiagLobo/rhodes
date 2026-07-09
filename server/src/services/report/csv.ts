import type { DossieDados } from '@rhodes/shared';

const ROTULO_CONFORMIDADE: Record<string, string> = {
  NO_PRAZO: 'No prazo',
  ATRASADA: 'Atrasada',
  JUSTIFICADA: 'Justificada',
  PERDIDA: 'Perdida',
  EM_ABERTO: 'Em aberto',
};

/** BOM UTF-8 (U+FEFF) — sem ele o Excel PT-BR abre o CSV com os acentos quebrados. */
const BOM = String.fromCharCode(0xfeff);

const CABECALHO = [
  'Área',
  'Atividade',
  'Frequência',
  'Intervalo (dias)',
  'Vencimento',
  'Status',
  'Conformidade',
  'Executante',
  'Concluído em',
  'Tempo (min)',
  'Resultado vistoria',
  'Vistoriador',
  'Navio',
  'Produto/Lote',
  'Nº fotos',
  'SHA-256 das fotos',
];

/**
 * Serializa uma célula: número sai cru; texto recebe (1) guarda anti-injeção de fórmula — célula
 * começando com `= + - @` (ou TAB/CR) o Excel/LibreOffice executa como fórmula (HYPERLINK/DDE), então
 * prefixa com `'`; e (2) escape RFC-4180 (aspas dobradas + envolve se houver `;`/`"`/quebra).
 */
function campo(v: string | number | null): string {
  if (typeof v === 'number') return String(v); // numérico controlado — sem guarda/escape
  const bruto = v ?? '';
  const s = /^[=+\-@\t\r]/.test(bruto) ? `'${bruto}` : bruto;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV das instâncias do período (Onda 09/S3), 1 linha por instância — a "planilha que a Ambev pedir".
 * UTF-8 com BOM (para o Excel PT-BR não quebrar acentos); separador `;` (padrão regional); linhas
 * terminadas em CRLF. Recebe o `DossieDados` já montado (o chamador passa o dossiê SEM o filtro de
 * "só reprovadas" — o CSV é todas as instâncias do período).
 */
export function gerarCsvInstancias(dados: DossieDados): string {
  const linhas = [CABECALHO.map(campo).join(';')];
  for (const p of dados.paginas) {
    linhas.push(
      [
        p.areaNome,
        p.atividade,
        p.frequency,
        p.intervalDays,
        p.dueDate,
        p.statusFinal,
        ROTULO_CONFORMIDADE[p.conformidade] ?? p.conformidade,
        p.executante ?? '',
        p.finishedAt ?? '',
        p.tempoExecucaoSeg === null ? '' : Math.round(p.tempoExecucaoSeg / 60),
        p.inspecao?.resultado ?? '',
        p.inspecao?.vistoriador ?? '',
        p.navioLote?.navio ?? '',
        p.navioLote?.produto ?? '',
        p.fotos.length,
        p.fotos.map((f) => f.sha256).join(' '),
      ]
        .map(campo)
        .join(';'),
    );
  }
  return `${BOM}${linhas.join('\r\n')}\r\n`;
}

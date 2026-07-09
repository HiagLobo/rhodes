import { diffDias, type RelatorioHistoricoItem } from '@rhodes/shared';

import { api, ApiError } from './api';

/** Espelha o teto do backend (relatorioFiltrosSchema): 186 dias corridos (~6 meses). */
export const RELATORIO_MAX_DIAS = 186;

export type FiltrosRelatorio = {
  inicio: string;
  fim: string;
  areaIds: number[];
  roundId: number | null;
  somenteReprovadasOuCriticas: boolean;
};

/**
 * Querystring dos filtros. `somenteReprovadasOuCriticas` só é anexado quando `true` — a string
 * `'false'` seria mal interpretada pelo parser (footgun de boolean), então "desligado" = ausente.
 */
export function querystringFiltros(f: FiltrosRelatorio): string {
  const p = new URLSearchParams();
  p.set('inicio', f.inicio);
  p.set('fim', f.fim);
  if (f.areaIds.length > 0) p.set('areaIds', f.areaIds.join(','));
  if (f.roundId !== null) p.set('roundId', String(f.roundId));
  if (f.somenteReprovadasOuCriticas) p.set('somenteReprovadasOuCriticas', 'true');
  return p.toString();
}

/** Validação de período no cliente — mesmos 186 dias corridos do backend (o 400 é a guarda final). */
export function periodoInvalido(inicio: string, fim: string): string | null {
  if (!inicio || !fim) return 'Informe o início e o fim do período.';
  if (fim < inicio) return 'O fim do período não pode ser antes do início.';
  if (diffDias(inicio, fim) > RELATORIO_MAX_DIAS) {
    return `O período não pode exceder ${RELATORIO_MAX_DIAS} dias (~6 meses).`;
  }
  return null;
}

function nomeArquivo(res: Response, fallback: string): string {
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename="?([^"]+)"?/.exec(cd);
  return m?.[1] ?? fallback;
}

/**
 * Baixa um arquivo autenticado (cookie de sessão). O wrapper `api()` sempre faz `res.json()` e não
 * serve para binário — aqui é `fetch` cru → `blob()` → download via `<a download>`. Em erro (4xx/5xx)
 * lê `{erro}` e lança `ApiError` (a tela mostra a mensagem).
 */
async function baixar(url: string, fallback: string): Promise<void> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    const corpo = (await res.json().catch(() => null)) as ApiError['corpo'];
    throw new ApiError(res.status, corpo);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = nomeArquivo(res, fallback);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoga DEPOIS de o browser iniciar o download — revogar de imediato pode cancelar um PDF grande.
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

export function baixarDossiePdf(f: FiltrosRelatorio): Promise<void> {
  return baixar(`/api/relatorios/dossie?${querystringFiltros(f)}`, `dossie-${f.inicio}-a-${f.fim}.pdf`);
}

export function baixarCsv(f: FiltrosRelatorio): Promise<void> {
  return baixar(`/api/relatorios/csv?${querystringFiltros(f)}`, `dossie-${f.inicio}-a-${f.fim}.csv`);
}

export function listarHistorico(): Promise<RelatorioHistoricoItem[]> {
  return api<RelatorioHistoricoItem[]>('/api/relatorios/historico');
}

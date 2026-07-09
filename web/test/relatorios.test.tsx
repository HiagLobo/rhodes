// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OperacaoNavio, RelatorioHistoricoItem, Usuario } from '@rhodes/shared';

import { AppRoutes } from '../src/App';
import { theme } from '../src/theme';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
  window.ResizeObserver =
    window.ResizeObserver ??
    (class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver);
  if (!document.fonts) {
    Object.defineProperty(document, 'fonts', {
      value: { addEventListener: () => {}, removeEventListener: () => {} },
    });
  }
  // Download: jsdom não implementa createObjectURL nem navegação do <a download>.
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function resposta(status: number, corpo: unknown) {
  return { ok: status < 400, status, json: () => Promise.resolve(corpo) } as Response;
}

function respostaArquivo(filename: string) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
    blob: () => Promise.resolve(new Blob(['%PDF-1.4'])),
    headers: {
      get: (h: string) =>
        h.toLowerCase() === 'content-disposition' ? `attachment; filename="${filename}"` : null,
    },
  } as unknown as Response;
}

type Rota = { metodo?: string; url: string; res: () => Response | Promise<Response> };

function mockFetch(rotas: Rota[]) {
  const chamadas: Array<{ url: string; metodo: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const metodo = init?.method ?? 'GET';
      chamadas.push({ url: String(url), metodo });
      const rota = rotas.find((r) => String(url).includes(r.url) && (r.metodo ?? 'GET') === metodo);
      if (!rota) return Promise.resolve(resposta(404, { erro: `não mockado: ${metodo} ${url}` }));
      return Promise.resolve(rota.res());
    }),
  );
  return chamadas;
}

const GESTOR: Usuario = { id: 1, nome: 'Gestor de Teste', login: 'gestor.teste', role: 'GESTOR', ativo: true };

const NAVIOS: OperacaoNavio[] = [
  { id: 7, navio: 'MV BOA VIAGEM', produto: 'MILHO', tonelagem: 48000, etaDate: '2026-06-09', status: 'ATRACADO', eventos: [] },
];

const HISTORICO: RelatorioHistoricoItem[] = [
  {
    ator: 'gestor.teste',
    criadoEm: '2026-07-09T12:00:00.000Z',
    filtros: { inicio: '2026-06-01', fim: '2026-06-30', somenteReprovadasOuCriticas: false },
    nInstancias: 5,
    hash: 'abcdef0123456789cafe',
    formato: 'PDF',
  },
];

function rotasBase(extra: Rota[] = []): Rota[] {
  return [
    { url: '/api/auth/me', res: () => resposta(200, GESTOR) },
    { url: '/api/areas', res: () => resposta(200, [{ id: 1, nome: 'Moega', pesoCriticidade: 1, ativo: true }]) },
    { url: '/api/navios', res: () => resposta(200, NAVIOS) },
    { url: '/api/relatorios/historico', res: () => resposta(200, HISTORICO) },
    ...extra,
  ];
}

function renderEm(rotas: Rota[]) {
  const chamadas = mockFetch(rotas);
  render(
    <MantineProvider theme={theme}>
      <MemoryRouter initialEntries={['/gestor/relatorios']}>
        <AppRoutes />
      </MemoryRouter>
    </MantineProvider>,
  );
  return chamadas;
}

function preencherPeriodo(inicio: string, fim: string) {
  fireEvent.change(screen.getByLabelText('Início'), { target: { value: inicio } });
  fireEvent.change(screen.getByLabelText('Fim'), { target: { value: fim } });
}

describe('Relatórios (gestor)', () => {
  it('renderiza o formulário e o histórico de gerações', async () => {
    renderEm(rotasBase());
    expect(await screen.findByText('Baixar PDF')).toBeDefined();
    expect(screen.getByText('Baixar CSV')).toBeDefined();
    // linha do histórico do mock
    expect(screen.getByText('gestor.teste')).toBeDefined();
    expect(screen.getByText('abcdef012345…')).toBeDefined();
  });

  it('baixar PDF com período válido dispara o fetch com a querystring (sem o flag quando desligado)', async () => {
    const chamadas = renderEm(rotasBase([{ url: '/api/relatorios/dossie', res: () => respostaArquivo('dossie.pdf') }]));
    await screen.findByText('Baixar PDF');
    preencherPeriodo('2026-06-01', '2026-06-30');
    fireEvent.click(screen.getByText('Baixar PDF'));

    const chamada = await vi.waitFor(() => {
      const c = chamadas.find((x) => x.url.includes('/api/relatorios/dossie'));
      if (!c) throw new Error('dossie ainda não chamado');
      return c;
    });
    expect(chamada.url).toContain('inicio=2026-06-01');
    expect(chamada.url).toContain('fim=2026-06-30');
    expect(chamada.url).not.toContain('somenteReprovadasOuCriticas');
  });

  it('com o switch ligado, a querystring inclui somenteReprovadasOuCriticas=true', async () => {
    const chamadas = renderEm(rotasBase([{ url: '/api/relatorios/csv', res: () => respostaArquivo('dossie.csv') }]));
    await screen.findByText('Baixar CSV');
    preencherPeriodo('2026-06-01', '2026-06-30');
    fireEvent.click(screen.getByLabelText('Só reprovadas / críticas'));
    fireEvent.click(screen.getByText('Baixar CSV'));

    const chamada = await vi.waitFor(() => {
      const c = chamadas.find((x) => x.url.includes('/api/relatorios/csv'));
      if (!c) throw new Error('csv ainda não chamado');
      return c;
    });
    expect(chamada.url).toContain('somenteReprovadasOuCriticas=true');
  });

  it('período inválido (fim antes do início) mostra erro e NÃO dispara o download', async () => {
    const chamadas = renderEm(rotasBase([{ url: '/api/relatorios/dossie', res: () => respostaArquivo('dossie.pdf') }]));
    await screen.findByText('Baixar PDF');
    preencherPeriodo('2026-06-30', '2026-06-01');
    fireEvent.click(screen.getByText('Baixar PDF'));

    expect(await screen.findByText(/não pode ser antes do início/i)).toBeDefined();
    expect(chamadas.some((x) => x.url.includes('/api/relatorios/dossie'))).toBe(false);
  });
});

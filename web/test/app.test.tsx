// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { Inicio } from '../src/pages/Inicio';
import { ALTURA_MINIMA_BOTAO, BANDAS, theme } from '../src/theme';

// A página Inicio (dashboard "Agora" desde a Onda 07) usa useNavigate → precisa de Router.
function renderInicio() {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter initialEntries={['/']}>
        <Inicio />
      </MemoryRouter>
    </MantineProvider>,
  );
}

function resposta(status: number, corpo: unknown) {
  return { ok: status < 400, status, json: () => Promise.resolve(corpo) } as Response;
}

const DASH = {
  cartoes: { atrasadas: 3, hoje: 5, aguardandoVistoria: 2, score30d: null },
  grade: [
    { grupo: 'Moegas', situacao: 'OVERDUE', atrasadas: 2, hoje: 0, abertas: 2 },
    { grupo: 'Silos', situacao: 'HOJE', atrasadas: 0, hoje: 3, abertas: 3 },
  ],
  rodada: { operacaoId: 1, navio: 'MV Cevada Star', status: 'DESCARGA_INICIADA', etaDate: '2026-07-20', total: 9, concluidas: 4 },
};

function mockDashboard() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const u = String(url);
      if (u.includes('/api/dashboard')) return Promise.resolve(resposta(200, DASH));
      if (u.includes('/api/agora')) return Promise.resolve(resposta(200, []));
      return Promise.resolve(resposta(404, { erro: 'não mockado' }));
    }),
  );
}

beforeAll(() => {
  // Mantine usa matchMedia/ResizeObserver, que não existem no jsdom
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('tema industrial', () => {
  it('exporta as 4 cores de banda SQF', () => {
    expect(Object.keys(BANDAS)).toEqual(['excelente', 'bom', 'atencao', 'critico']);
  });

  it('botão default tem altura mínima ≥56px (uso com luvas)', () => {
    expect(ALTURA_MINIMA_BOTAO).toBeGreaterThanOrEqual(56);
    const styles = theme.components?.Button?.styles as { root?: { minHeight?: number } };
    expect(styles.root?.minHeight).toBe(ALTURA_MINIMA_BOTAO);
  });
});

describe('dashboard "Agora" — 3 estados', () => {
  it('mostra "carregando" enquanto o painel não responde', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    renderInicio();
    expect(screen.getByText(/Carregando o painel/i)).toBeDefined();
  });

  it('renderiza cartões e grade quando o dashboard responde', async () => {
    mockDashboard();
    renderInicio();
    expect(await screen.findByText('Atrasadas')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined(); // atrasadas
    expect(screen.getByText('Moegas')).toBeDefined();
    expect(screen.getByText('Silos')).toBeDefined();
    expect(screen.getByText(/rodada 4 de 9/)).toBeDefined();
    expect(screen.getByText(/sem dado ainda/)).toBeDefined(); // score30d null
  });

  it('mostra erro com "tentar novamente" quando o painel falha', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('rede fora'))),
    );
    renderInicio();
    expect(await screen.findByText(/Não foi possível carregar/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /Tentar novamente/i })).toBeDefined();
  });
});

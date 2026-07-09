// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function resposta(status: number, corpo: unknown) {
  return { ok: status < 400, status, json: () => Promise.resolve(corpo) } as Response;
}

const ESCOPO = {
  score: 82,
  banda: 'ATENCAO',
  componentes: {
    pontualidade: { valor: 0.9, n: 20 },
    aprovacao: { valor: null, n: 0 },
    cobertura: { valor: 0.75, n: 39 },
  },
  demeritos: 3,
  n: 20,
  incertezaMais: 91,
  incertezaMenos: 73,
  taxaJustificadas: 0.25,
};

const SCORE = {
  ...ESCOPO,
  areas: [
    { ...ESCOPO, areaId: 1, nome: 'Silo 01' },
    { areaId: 2, nome: 'Moega', score: null, banda: null, componentes: ESCOPO.componentes, demeritos: 0, n: 0, incertezaMais: null, incertezaMenos: null, taxaJustificadas: 0 },
  ],
};

function mock(role = 'GESTOR') {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const u = String(url);
      if (u.includes('/api/auth/me')) {
        return Promise.resolve(resposta(200, { id: 1, nome: 'G', login: 'g', role, ativo: true }));
      }
      if (u.includes('/api/score')) return Promise.resolve(resposta(200, SCORE));
      return Promise.resolve(resposta(404, { erro: 'não mockado' }));
    }),
  );
}

function renderRota() {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter initialEntries={['/score']}>
        <AppRoutes />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe('painel de score', () => {
  it('mostra geral, componentes (aprovação sem dado), taxa >20% alertada e áreas', async () => {
    mock();
    renderRota();
    expect(await screen.findByText('Score geral')).toBeDefined();
    expect(screen.getAllByText('82').length).toBeGreaterThan(0); // geral + linha da área Silo 01
    expect(screen.getAllByText('sem dado').length).toBeGreaterThan(0); // aprovação e área null
    expect(screen.getByText(/acima de 20%/)).toBeDefined(); // taxaJustificadas 25%
    expect(screen.getByText(/−3/)).toBeDefined(); // deméritos
    expect(screen.getByText('Silo 01')).toBeDefined();
    expect(screen.getByText('Moega')).toBeDefined();
  });

  it('leitura para todos: executante também abre a tela', async () => {
    mock('EXECUTANTE');
    renderRota();
    expect(await screen.findByText('Score geral')).toBeDefined();
  });
});

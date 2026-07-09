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

const CAL = {
  mes: '2026-07',
  ocorrencias: [
    { dia: '2026-07-06', templateId: 1, atividade: 'Lavagem', areaNome: 'Moega de Recebimento (superior)', status: 'DONE_ON_TIME', projetado: false },
    { dia: '2026-07-20', templateId: 1, atividade: 'Lavagem', areaNome: 'Moega de Recebimento (superior)', status: null, projetado: true },
  ],
  dependeDeNavio: [{ templateId: 9, atividade: 'Rodada pós-navio', areaNome: 'Túnel Recebimento' }],
};

function mock() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const u = String(url);
      if (u.includes('/api/auth/me')) {
        return Promise.resolve(resposta(200, { id: 1, nome: 'G', login: 'g', role: 'GESTOR', ativo: true }));
      }
      if (u.includes('/api/calendario')) return Promise.resolve(resposta(200, CAL));
      return Promise.resolve(resposta(404, { erro: 'não mockado' }));
    }),
  );
}

function renderCalendario() {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter initialEntries={['/gestor/calendario']}>
        <AppRoutes />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe('calendário do gestor', () => {
  it('mostra materializadas e projetadas distinguíveis + depende de navio', async () => {
    mock();
    renderCalendario();
    expect(await screen.findByText('2026-07')).toBeDefined();
    // a legenda distingue projetada
    expect(screen.getByText(/projetada/)).toBeDefined();
    // a área aparece nas células (materializada e projetada)
    expect(screen.getAllByText('Moega de Recebimento (superior)').length).toBeGreaterThanOrEqual(2);
    // bloco "depende de navio"
    expect(screen.getByText(/Dependem de navio/)).toBeDefined();
    expect(screen.getByText(/Rodada pós-navio/)).toBeDefined();
  });
});

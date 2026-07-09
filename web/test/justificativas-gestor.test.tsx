// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

function filaItem(id: number, motivo: string, texto: string | null = null) {
  return {
    id,
    instanceId: id,
    motivo,
    texto,
    fotoId: null,
    status: 'PENDENTE',
    criadoPor: 'executante.teste',
    criadoEm: '2026-07-09T10:00:00.000Z',
    classificacao: null,
    decididoPor: null,
    decididoEm: null,
    decisaoObs: null,
    areaNome: 'Silo 01',
    atividade: 'Varrição',
    dueDate: '2026-07-09',
  };
}

const PARETO = {
  total: 3,
  pareto: [
    { motivo: 'CHUVA', total: 2, pct: 67 },
    { motivo: 'OUTRO', total: 1, pct: 33 },
    { motivo: 'NAVIO_OPERANDO', total: 0, pct: 0 },
  ],
};

function mockCom(fila: unknown[], onDecisao?: (body: string) => void) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/auth/me')) {
        return Promise.resolve(resposta(200, { id: 1, nome: 'G', login: 'g', role: 'GESTOR', ativo: true }));
      }
      if (u.includes('/decisao') && init?.method === 'PATCH') {
        onDecisao?.(String(init.body));
        return Promise.resolve(resposta(200, {}));
      }
      if (u.includes('/pareto')) return Promise.resolve(resposta(200, PARETO));
      if (u.includes('/api/justificativas')) return Promise.resolve(resposta(200, fila));
      return Promise.resolve(resposta(404, { erro: 'não mockado' }));
    }),
  );
}

function renderRota() {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter initialEntries={['/gestor/justificativas']}>
        <AppRoutes />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe('fila de justificativas (gestor)', () => {
  it('lista pendentes com rótulo do motivo e Pareto', async () => {
    mockCom([filaItem(1, 'CHUVA'), filaItem(2, 'OUTRO', 'vazamento')]);
    renderRota();
    expect(await screen.findByText('Pendentes (2)')).toBeDefined();
    expect(screen.getAllByText('Chuva').length).toBeGreaterThan(0);
    expect(screen.getByText(/Pareto por motivo/)).toBeDefined();
    expect(screen.getByText(/2 \(67%\)/)).toBeDefined();
  });

  it('aprovar motivo padrão dispara PATCH sem classificação', async () => {
    let corpo = '';
    mockCom([filaItem(1, 'CHUVA')], (b) => (corpo = b));
    renderRota();
    fireEvent.click(await screen.findByRole('button', { name: 'Aprovar' }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirmar aprovação/ }));
    await screen.findByText('Pendentes (1)'); // recarregou
    expect(JSON.parse(corpo)).toMatchObject({ decisao: 'APROVADA' });
    expect(JSON.parse(corpo).classificacao).toBeUndefined();
  });

  it('aprovar OUTRO exige escolher EXTERNA/INTERNA antes de confirmar', async () => {
    let corpo = '';
    mockCom([filaItem(1, 'OUTRO', 'motivo a apurar')], (b) => (corpo = b));
    renderRota();
    fireEvent.click(await screen.findByRole('button', { name: 'Aprovar' }));
    // confirmar sem classificar → erro local, sem PATCH
    fireEvent.click(await screen.findByRole('button', { name: /Confirmar aprovação/ }));
    expect(await screen.findByText(/EXTERNA ou INTERNA/)).toBeDefined();
    expect(corpo).toBe('');

    fireEvent.click(screen.getByRole('button', { name: /Interna/ }));
    fireEvent.click(screen.getByRole('button', { name: /Confirmar aprovação/ }));
    await screen.findByText('Pendentes (1)');
    expect(JSON.parse(corpo)).toMatchObject({ decisao: 'APROVADA', classificacao: 'INTERNA' });
  });
});

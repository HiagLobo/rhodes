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

const PENDENTE = {
  inspectionId: 5,
  instanceId: 10,
  areaId: 1,
  areaNome: 'Silo 01',
  atividade: 'Varrição',
  severidade: 'CRITICA',
  vistoriador: 'vistoriador.teste',
  criadoEm: '2026-07-09T10:00:00.000Z',
};

function mock(onConfirm?: (body: string) => void) {
  let confirmado = false;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/auth/me')) {
        return Promise.resolve(resposta(200, { id: 1, nome: 'G', login: 'g', role: 'GESTOR', ativo: true }));
      }
      if (u.includes('/api/demeritos') && init?.method === 'POST') {
        confirmado = true;
        onConfirm?.(String(init.body));
        return Promise.resolve(resposta(201, {}));
      }
      if (u.includes('/api/demeritos/pendentes')) {
        return Promise.resolve(resposta(200, confirmado ? [] : [PENDENTE]));
      }
      if (u.includes('/api/demeritos')) return Promise.resolve(resposta(200, [])); // confirmados
      return Promise.resolve(resposta(404, { erro: 'não mockado' }));
    }),
  );
}

function renderRota() {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter initialEntries={['/gestor/demeritos']}>
        <AppRoutes />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe('fila de deméritos (gestor)', () => {
  it('lista pendentes com severidade e confirmar dispara POST', async () => {
    let corpo = '';
    mock((b) => (corpo = b));
    renderRota();
    expect(await screen.findByText('Varrição')).toBeDefined();
    expect(screen.getByText('CRITICA')).toBeDefined();
    expect(screen.getByText(/reprovada por vistoriador\.teste/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Confirmar demérito' }));
    await screen.findByText(/Nenhuma reprovação grave/); // recarregou vazio
    expect(JSON.parse(corpo)).toMatchObject({ inspectionId: 5 });
  });
});

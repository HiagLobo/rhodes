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

const ITENS = [
  {
    id: 10,
    templateId: 1,
    areaId: 1,
    areaNome: 'Moega de Recebimento (superior)',
    atividade: 'Lavagem com lava-jato',
    frequency: 'QUINZENAL',
    triggerType: 'HYBRID',
    dueDate: '2026-07-01',
    windowEnd: '2026-07-02',
    status: 'OVERDUE',
    origin: 'SHIP',
    executanteLogin: null,
  },
  {
    id: 11,
    templateId: 2,
    areaId: 2,
    areaNome: 'Silo 01',
    atividade: 'Inspeção e limpeza',
    frequency: 'SEMESTRAL',
    triggerType: 'CALENDAR',
    dueDate: '2026-07-20',
    windowEnd: '2026-08-07',
    status: 'PENDING',
    origin: 'CALENDAR',
    executanteLogin: null,
  },
];

function mockCom(usuario: { role: string }) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const u = String(url);
      if (u.includes('/api/auth/me')) {
        return Promise.resolve(
          resposta(200, { id: 1, nome: 'Teste', login: 'x', ativo: true, ...usuario }),
        );
      }
      if (u.includes('/api/agora')) return Promise.resolve(resposta(200, ITENS));
      return Promise.resolve(resposta(404, { erro: 'não mockado' }));
    }),
  );
}

function renderAgora() {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter initialEntries={['/agora']}>
        <AppRoutes />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe('tela AGORA', () => {
  it('agrupa por área, mostra Atrasada e ⚓ NAVIO', async () => {
    mockCom({ role: 'EXECUTANTE' });
    renderAgora();
    expect(await screen.findByText('Moega de Recebimento (superior)')).toBeDefined();
    expect(screen.getByText('Silo 01')).toBeDefined();
    expect(screen.getByText('Atrasada')).toBeDefined();
    expect(screen.getByText('⚓ NAVIO')).toBeDefined();
  });

  it('EXECUTANTE vê o botão Abrir (ação vive na tela da tarefa); VISTORIADOR não vê ações', async () => {
    mockCom({ role: 'EXECUTANTE' });
    renderAgora();
    expect((await screen.findAllByRole('button', { name: 'Abrir' })).length).toBe(2);
    cleanup();
    vi.unstubAllGlobals();

    mockCom({ role: 'VISTORIADOR' });
    renderAgora();
    await screen.findByText('Silo 01');
    expect(screen.queryByRole('button', { name: 'Abrir' })).toBeNull();
  });

  it('lista vazia mostra "Tudo em dia"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const u = String(url);
        if (u.includes('/api/auth/me')) {
          return Promise.resolve(
            resposta(200, { id: 1, nome: 'T', login: 'x', role: 'GESTOR', ativo: true }),
          );
        }
        if (u.includes('/api/agora')) return Promise.resolve(resposta(200, []));
        return Promise.resolve(resposta(404, {}));
      }),
    );
    renderAgora();
    expect(await screen.findByText(/Tudo em dia/)).toBeDefined();
  });
});

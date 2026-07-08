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

const OPERACAO_ATIVA = {
  id: 1,
  navio: 'MV Cevada Star',
  produto: 'Cevada',
  tonelagem: 30000,
  etaDate: '2026-07-20',
  status: 'ATRACADO',
  eventos: [
    {
      id: 1,
      transicao: 'ANUNCIADO',
      eventAt: '2026-07-08T12:00:00.000Z',
      registeredAt: '2026-07-08T12:00:00.000Z',
      registradoPor: 'gestor.teste',
      confirmado: true,
    },
    {
      id: 2,
      transicao: 'ATRACADO',
      eventAt: '2026-07-09T06:30:00.000Z',
      registeredAt: '2026-07-09T11:00:00.000Z',
      registradoPor: 'executante.teste',
      confirmado: false,
    },
  ],
};

function mockCom(role: string, operacoes: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const u = String(url);
      if (u.includes('/api/auth/me')) {
        return Promise.resolve(resposta(200, { id: 1, nome: 'T', login: 'x', role, ativo: true }));
      }
      if (u.includes('/rodada')) {
        return Promise.resolve(
          resposta(200, {
            resumo: { total: 9, concluidas: 3 },
            itens: [
              { id: 1, areaNome: 'Moega de Recebimento (superior)', atividade: 'Lavagem', status: 'DONE_ON_TIME' },
            ],
          }),
        );
      }
      if (u.includes('/api/navios')) return Promise.resolve(resposta(200, operacoes));
      return Promise.resolve(resposta(404, { erro: 'não mockado' }));
    }),
  );
}

function renderNavios() {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter initialEntries={['/navios']}>
        <AppRoutes />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe('tela de Navios', () => {
  it('sem operação ativa: botão Anunciar para quem registra', async () => {
    mockCom('EXECUTANTE', []);
    renderNavios();
    expect(await screen.findByRole('button', { name: /Anunciar navio/ })).toBeDefined();
  });

  it('com ativa: próxima transição correta, retroativo sinalizado, confirmação pendente, rodada n/m', async () => {
    mockCom('GESTOR', [OPERACAO_ATIVA]);
    renderNavios();
    expect(await screen.findByText('⚓ MV Cevada Star')).toBeDefined();
    expect(screen.getByRole('button', { name: /Registrar: Descarga iniciada/ })).toBeDefined();
    expect(screen.getByText(/\(retroativo\)/)).toBeDefined();
    expect(screen.getByText('aguarda confirmação do gestor')).toBeDefined();
    expect(screen.getByText(/3 de 9 concluídas/)).toBeDefined();
  });

  it('vistoriador lê mas não vê ações', async () => {
    mockCom('VISTORIADOR', [OPERACAO_ATIVA]);
    renderNavios();
    expect(await screen.findByText('⚓ MV Cevada Star')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Registrar:/ })).toBeNull();
  });
});

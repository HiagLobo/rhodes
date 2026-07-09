// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { Tv } from '../src/pages/Tv';
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
  vi.useRealTimers();
});

function resposta(status: number, corpo: unknown) {
  return { ok: status < 400, status, json: () => Promise.resolve(corpo) } as Response;
}

const DASH = {
  cartoes: { atrasadas: 4, hoje: 2, aguardandoVistoria: 1, score30d: null, gap: null, notaExterna: null, orgaoExterno: null },
  grade: [{ grupo: 'Moegas', situacao: 'OVERDUE', atrasadas: 4, hoje: 0, abertas: 4 }],
  rodada: null,
};

function renderTv() {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter initialEntries={['/tv']}>
        <Tv />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe('TV andon', () => {
  it('renderiza a grade e os cartões do dashboard', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(resposta(200, DASH))));
    renderTv();
    expect(await screen.findByText('Moegas')).toBeDefined();
    expect(screen.getByText('ATRASADAS')).toBeDefined();
    expect(screen.getByText('4')).toBeDefined();
  });

  it('repolla a cada 30s (fakeTimers)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve(resposta(200, DASH)));
    vi.stubGlobal('fetch', fetchMock);
    renderTv();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falha de REDE mantém o último dado + selo "sem conexão"', async () => {
    let chamada = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        chamada += 1;
        return chamada === 1
          ? Promise.resolve(resposta(200, DASH))
          : Promise.reject(new Error('offline'));
      }),
    );
    vi.useFakeTimers();
    renderTv();
    await vi.waitFor(() => expect(screen.getByText('Moegas')).toBeDefined());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // dado antigo continua; selo de rede aparece; NÃO fala em sessão
    expect(screen.getByText('Moegas')).toBeDefined();
    expect(screen.getByText(/sem conexão/)).toBeDefined();
    expect(screen.queryByText(/sessão expirada/)).toBeNull();
  });

  it('401 (cookie de 12h venceu) mostra "sessão expirada", distinto de rede', async () => {
    let chamada = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        chamada += 1;
        return chamada === 1
          ? Promise.resolve(resposta(200, DASH))
          : Promise.resolve(resposta(401, { erro: 'sessão expirada' }));
      }),
    );
    vi.useFakeTimers();
    renderTv();
    await vi.waitFor(() => expect(screen.getByText('Moegas')).toBeDefined());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByText(/sessão expirada/)).toBeDefined();
    expect(screen.queryByText(/sem conexão/)).toBeNull();
  });
});

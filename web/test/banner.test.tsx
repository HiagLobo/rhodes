// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Notificacoes, Usuario } from '@rhodes/shared';

import { BannerNotificacoes } from '../src/components/BannerNotificacoes';
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
  sessionStorage.clear();
});

function resposta(status: number, corpo: unknown) {
  return { ok: status < 400, status, json: () => Promise.resolve(corpo) } as Response;
}

const GESTOR: Usuario = { id: 1, nome: 'G', login: 'g', role: 'GESTOR', ativo: true };

function vazio(): Notificacoes {
  return { overdue: 0, escalonadas: 0, retrabalhos: 0, decisoes: 0, justificativasPendentes: 0, filaVistoria: 0 };
}

function mockSeq(payloads: Notificacoes[]) {
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      const p = payloads[Math.min(i, payloads.length - 1)];
      i += 1;
      return Promise.resolve(resposta(200, p));
    }),
  );
}

function renderBanner() {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter>
        <BannerNotificacoes usuario={GESTOR} />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe('banner de notificações', () => {
  it('aparece com overdue>0 e some quando zera', async () => {
    mockSeq([{ ...vazio(), overdue: 5 }, vazio()]);
    vi.useFakeTimers();
    renderBanner();
    await vi.waitFor(() => expect(screen.getByText(/5 tarefa\(s\) atrasada/)).toBeDefined());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.queryByText(/atrasada/)).toBeNull();
  });

  it('escalonadas têm texto mais duro', async () => {
    mockSeq([{ ...vazio(), overdue: 3, escalonadas: 3 }]);
    renderBanner();
    expect(await screen.findByText(/há \+1 dia/)).toBeDefined();
  });

  it('dispensar oculta; incidente 5→0→5 reexibe', async () => {
    mockSeq([
      { ...vazio(), overdue: 5 },
      { ...vazio(), overdue: 5 }, // ainda 5 → dispensa continua valendo
      vazio(), // zera → limpa a dispensa
      { ...vazio(), overdue: 5 }, // novo incidente → reexibe
    ]);
    vi.useFakeTimers();
    renderBanner();
    await vi.waitFor(() => expect(screen.getByText(/5 tarefa/)).toBeDefined());

    act(() => screen.getByText(/dispensar/).click());
    expect(screen.queryByText(/5 tarefa/)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000); // ainda 5 → segue dispensado
    });
    expect(screen.queryByText(/5 tarefa/)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000); // zera
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000); // volta a 5 → reexibe
    });
    expect(screen.getByText(/5 tarefa/)).toBeDefined();
  });

  it('falha de rede não quebra: banner segue com o último estado', async () => {
    let i = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        i += 1;
        return i === 1
          ? Promise.resolve(resposta(200, { ...vazio(), overdue: 2 }))
          : Promise.reject(new Error('offline'));
      }),
    );
    vi.useFakeTimers();
    renderBanner();
    await vi.waitFor(() => expect(screen.getByText(/2 tarefa/)).toBeDefined());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByText(/2 tarefa/)).toBeDefined(); // manteve
  });
});

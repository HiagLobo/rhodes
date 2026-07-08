// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App';
import { ALTURA_MINIMA_BOTAO, BANDAS, theme } from '../src/theme';

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

function healthOk(version: string) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ status: 'ok', db: 'ok', version }),
  } as Response;
}

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

describe('página Início — 3 estados', () => {
  it('mostra "conectando" enquanto o health não responde', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<App />);
    expect(screen.getByText(/Conectando ao servidor/i)).toBeDefined();
  });

  it('mostra "servidor no ar" com a versão quando o health responde', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(healthOk('9.9.9'))));
    render(<App />);
    expect(await screen.findByText(/Servidor no ar/i)).toBeDefined();
    expect(screen.getByText(/9\.9\.9/)).toBeDefined();
  });

  it('mostra erro com "tentar novamente" quando o health falha', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('rede fora'))),
    );
    render(<App />);
    expect(await screen.findByText(/Servidor fora do ar/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /Tentar novamente/i })).toBeDefined();
  });
});

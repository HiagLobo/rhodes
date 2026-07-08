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

function renderEm(rota: string) {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter initialEntries={[rota]}>
        <AppRoutes />
      </MemoryRouter>
    </MantineProvider>,
  );
}

function resposta(status: number, corpo: unknown) {
  return { ok: status < 400, status, json: () => Promise.resolve(corpo) } as Response;
}

/** fetch mock roteado por URL — cada teste declara o que cada endpoint devolve. */
function mockFetch(rotas: Record<string, () => Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const chave = Object.keys(rotas).find((k) => String(url).includes(k));
      if (!chave) return Promise.resolve(resposta(404, { erro: 'não mockado' }));
      return Promise.resolve(rotas[chave]!());
    }),
  );
}

describe('tela de login', () => {
  it('senha errada mostra o erro genérico do servidor', async () => {
    mockFetch({
      '/api/auth/login': () => resposta(401, { erro: 'Login ou senha inválidos.' }),
    });
    renderEm('/login');
    fireEvent.change(screen.getByPlaceholderText('seu.login'), { target: { value: 'gestor.teste' } });
    fireEvent.change(screen.getByPlaceholderText('sua senha'), { target: { value: 'errada' } });
    fireEvent.click(screen.getByRole('button', { name: /entrar/i }));
    expect(await screen.findByText(/Login ou senha inválidos/)).toBeDefined();
  });

  it('login ok navega para a área logada (guarda consulta /me)', async () => {
    const usuario = { id: 1, nome: 'Gestor de Teste', login: 'gestor.teste', role: 'GESTOR', ativo: true };
    mockFetch({
      '/api/auth/login': () => resposta(200, usuario),
      '/api/auth/me': () => resposta(200, usuario),
      '/api/health': () => resposta(200, { status: 'ok', db: 'ok', version: '0.0.0' }),
    });
    renderEm('/login');
    fireEvent.change(screen.getByPlaceholderText('seu.login'), { target: { value: 'gestor.teste' } });
    fireEvent.change(screen.getByPlaceholderText('sua senha'), { target: { value: 'certa-e-longa' } });
    fireEvent.click(screen.getByRole('button', { name: /entrar/i }));
    expect(await screen.findByText('GESTOR')).toBeDefined();
  });
});

describe('guarda de sessão', () => {
  it('sem sessão, acessar / cai na tela de login', async () => {
    mockFetch({
      '/api/auth/me': () => resposta(401, { erro: 'Sessão inválida' }),
    });
    renderEm('/');
    expect(await screen.findByRole('button', { name: /entrar/i })).toBeDefined();
  });

  it('com sessão, / mostra o shell com nome e papel', async () => {
    mockFetch({
      '/api/auth/me': () =>
        resposta(200, { id: 2, nome: 'Executante de Teste', login: 'executante.teste', role: 'EXECUTANTE', ativo: true }),
      '/api/health': () => resposta(200, { status: 'ok', db: 'ok', version: '0.0.0' }),
    });
    renderEm('/');
    expect(await screen.findByText('EXECUTANTE')).toBeDefined();
    expect(screen.queryByRole('button', { name: /usuários/i })).toBeNull(); // menu de gestor não aparece
  });
});

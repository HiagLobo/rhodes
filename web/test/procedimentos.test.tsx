// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Area, Procedimento, ProcedimentoDetalhe, Usuario } from '@rhodes/shared';

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
  // Textarea autosize do Mantine escuta document.fonts, que o jsdom não implementa
  if (!document.fonts) {
    Object.defineProperty(document, 'fonts', {
      value: { addEventListener: () => {}, removeEventListener: () => {} },
    });
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function resposta(status: number, corpo: unknown) {
  return { ok: status < 400, status, json: () => Promise.resolve(corpo) } as Response;
}

type Rota = { metodo?: string; url: string; res: () => Response | Promise<Response> };

/** Resposta que nunca chega — para testar estados de carregando. */
const PENDENTE = () => new Promise<Response>(() => {});

/** Mock de fetch por (método, prefixo de URL) — a PRIMEIRA rota que casar responde. */
function mockFetch(rotas: Rota[]) {
  const chamadas: Array<{ url: string; metodo: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const metodo = init?.method ?? 'GET';
      chamadas.push({ url: String(url), metodo });
      const rota = rotas.find(
        (r) => String(url).includes(r.url) && (r.metodo ?? 'GET') === metodo,
      );
      if (!rota) return Promise.resolve(resposta(404, { erro: `não mockado: ${metodo} ${url}` }));
      return Promise.resolve(rota.res());
    }),
  );
  return chamadas;
}

const GESTOR: Usuario = { id: 1, nome: 'Gestor de Teste', login: 'gestor.teste', role: 'GESTOR', ativo: true };
const EXECUTANTE: Usuario = {
  id: 2,
  nome: 'Executante de Teste',
  login: 'executante.teste',
  role: 'EXECUTANTE',
  ativo: true,
};

const AREAS: Area[] = [
  { id: 1, nome: 'Moega de Recebimento (superior)', pesoCriticidade: 1.25, ativo: true },
  { id: 2, nome: 'Silo 01', pesoCriticidade: 1.5, ativo: true },
];

function proc(p: Partial<Procedimento> & { id: number; areaId: number }): Procedimento {
  return {
    atividade: `Atividade ${p.id}`,
    frequency: 'QUINZENAL',
    intervalDays: 14,
    scheduleMode: 'FLOATING',
    graceDays: 1,
    triggerType: 'CALENDAR',
    shipPhase: null,
    leadDays: null,
    limitacoes: null,
    dependsOnTemplateId: null,
    ativo: true,
    metodoAtual: { id: p.id * 10, versao: 1, texto: `Método ${p.id}`, criadoEm: '2026-07-08T12:00:00.000Z', criadoPor: null },
    ...p,
  };
}

const LISTA: Procedimento[] = [
  proc({ id: 1, areaId: 1, atividade: 'Lavagem da moega superior', triggerType: 'HYBRID', shipPhase: 'POST_OPERATION', leadDays: 2 }),
  proc({ id: 2, areaId: 1, atividade: 'Inspeção das telas da moega' }),
  proc({ id: 3, areaId: 2, atividade: 'Limpeza semestral do silo', frequency: 'SEMESTRAL', intervalDays: 182, graceDays: 18 }),
];

const DETALHE: ProcedimentoDetalhe = {
  ...proc({ id: 5, areaId: 2, atividade: 'Procedimento com histórico' }),
  metodoAtual: { id: 51, versao: 2, texto: 'Texto da versão dois.', criadoEm: '2026-07-08T12:00:00.000Z', criadoPor: 'gestor.teste' },
  historico: [
    { id: 51, versao: 2, texto: 'Texto da versão dois.', criadoEm: '2026-07-08T12:00:00.000Z', criadoPor: 'gestor.teste' },
    { id: 50, versao: 1, texto: 'Texto original da versão um.', criadoEm: '2026-07-01T12:00:00.000Z', criadoPor: null },
  ],
};

function renderEm(rota: string, rotas: Rota[]) {
  const chamadas = mockFetch(rotas);
  render(
    <MantineProvider theme={theme}>
      <MemoryRouter initialEntries={[rota]}>
        <AppRoutes />
      </MemoryRouter>
    </MantineProvider>,
  );
  return chamadas;
}

describe('Plano Mestre — lista', () => {
  it('agrupa por área, mostra peso e ⚓ NAVIO nas híbridas', async () => {
    renderEm('/gestor/procedimentos', [
      { url: '/api/auth/me', res: () => resposta(200, GESTOR) },
      { url: '/api/areas', res: () => resposta(200, AREAS) },
      { url: '/api/procedimentos?inativos=1', res: () => resposta(200, LISTA) },
    ]);
    expect(await screen.findByText('Moega de Recebimento (superior)')).toBeDefined();
    expect(screen.getByText('Silo 01')).toBeDefined();
    expect(screen.getByText('peso 1.25')).toBeDefined();
    // abre o accordion da moega para ver os itens
    fireEvent.click(screen.getByText('Moega de Recebimento (superior)'));
    expect(await screen.findByText('Lavagem da moega superior')).toBeDefined();
    expect(screen.getAllByText('⚓ NAVIO').length).toBe(1);
  });

  it('mostra estado de carregando enquanto a API não responde', async () => {
    renderEm('/gestor/procedimentos', [
      { url: '/api/auth/me', res: () => resposta(200, GESTOR) },
      { url: '/api/areas', res: PENDENTE },
      { url: '/api/procedimentos', res: PENDENTE },
    ]);
    expect(await screen.findByText(/Carregando o plano mestre/i)).toBeDefined();
  });
});

describe('Plano Mestre — detalhe', () => {
  it('mostra método vigente, histórico em ordem decrescente e v1 preservada', async () => {
    renderEm('/gestor/procedimentos/5', [
      { url: '/api/auth/me', res: () => resposta(200, GESTOR) },
      { url: '/api/areas', res: () => resposta(200, AREAS) },
      { url: '/api/procedimentos/5', res: () => resposta(200, DETALHE) },
    ]);
    expect(await screen.findByText('Procedimento com histórico')).toBeDefined();
    expect(screen.getByText(/método vigente — v2/)).toBeDefined();
    const badges = screen.getAllByText(/^v\d$/).map((e) => e.textContent);
    expect(badges).toEqual(['v2', 'v1']);
    expect(screen.getByText('Texto original da versão um.')).toBeDefined();
  });

  it('salvar nova versão chama POST /api/procedimentos/:id/metodo', async () => {
    const chamadas = renderEm('/gestor/procedimentos/5', [
      { url: '/api/auth/me', res: () => resposta(200, GESTOR) },
      { url: '/api/areas', res: () => resposta(200, AREAS) },
      {
        metodo: 'POST',
        url: '/api/procedimentos/5/metodo',
        res: () => resposta(201, DETALHE.metodoAtual),
      },
      { url: '/api/procedimentos/5', res: () => resposta(200, DETALHE) },
    ]);
    await screen.findByText('Procedimento com histórico');
    fireEvent.click(screen.getByRole('button', { name: /nova versão do método/i }));
    fireEvent.click(await screen.findByRole('button', { name: /salvar como v3/i }));
    await vi.waitFor(() => {
      expect(
        chamadas.some((c) => c.metodo === 'POST' && c.url.includes('/api/procedimentos/5/metodo')),
      ).toBe(true);
    });
  });
});

describe('menu por papel (cosmético — a API é quem manda)', () => {
  it('EXECUTANTE não vê o link Plano Mestre', async () => {
    renderEm('/', [
      { url: '/api/auth/me', res: () => resposta(200, EXECUTANTE) },
      { url: '/api/health', res: () => resposta(200, { status: 'ok', db: 'ok', version: '0.0.0' }) },
    ]);
    expect(await screen.findByText('EXECUTANTE')).toBeDefined();
    expect(screen.queryByText('Plano Mestre')).toBeNull();
  });

  it('GESTOR vê o link Plano Mestre', async () => {
    renderEm('/', [
      { url: '/api/auth/me', res: () => resposta(200, GESTOR) },
      { url: '/api/health', res: () => resposta(200, { status: 'ok', db: 'ok', version: '0.0.0' }) },
    ]);
    expect(await screen.findByText('Plano Mestre')).toBeDefined();
  });
});

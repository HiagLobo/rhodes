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

function foto(id: number, tipo: string, parte = 1) {
  return {
    id,
    instanceId: 1,
    tipo,
    parte,
    capturedAt: '2026-07-08T12:00:00.000Z',
    receivedAt: '2026-07-08T12:00:00.000Z',
    skewMs: 0,
    exifDatetime: null,
    exifModel: null,
    tamanhoBytes: 1000,
    enviadoPor: 'executante.teste',
  };
}

function detalheBase(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    templateId: 1,
    areaId: 1,
    areaNome: 'Moega de Recebimento (superior)',
    atividade: 'Lavagem com água e detergente',
    frequency: 'DIARIO',
    triggerType: 'CALENDAR',
    dueDate: '2026-07-08',
    windowEnd: '2026-07-08',
    status: 'IN_PROGRESS',
    origin: 'CALENDAR',
    executanteLogin: 'x',
    limitacoes: null,
    metodo: null,
    minFotosIntervaloMin: 5,
    startedAt: null,
    finishedAt: null,
    fotos: [] as unknown[],
    partes: [] as unknown[],
    parteCorrente: 1,
    tempoExecucaoSeg: null,
    justificativa: null,
    ...overrides,
  };
}

function renderTarefa() {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter initialEntries={['/tarefas/1']}>
        <AppRoutes />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe('justificativa na tela da tarefa', () => {
  function mockJustificar(role: string) {
    const chamadas: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/api/auth/me')) {
          return Promise.resolve(resposta(200, { id: 1, nome: 'T', login: 'x', role, ativo: true }));
        }
        if (u.includes('/justificar') && init?.method === 'POST') {
          chamadas.push(String(init.body));
          return Promise.resolve(
            resposta(200, { statusFinal: 'MISSED', justificativaId: 1, proximaDue: '2026-07-09' }),
          );
        }
        if (u.includes('/api/instancias/1')) return Promise.resolve(resposta(200, detalheBase()));
        return Promise.resolve(resposta(404, { erro: 'não mockado' }));
      }),
    );
    return chamadas;
  }

  it('OUTRO exige texto (validação local do contrato); CHUVA envia e mostra o reagendamento', async () => {
    const chamadas = mockJustificar('EXECUTANTE');
    renderTarefa();

    fireEvent.click(await screen.findByRole('button', { name: 'Não foi possível realizar' }));
    expect(await screen.findByRole('button', { name: 'Navio operando na área' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Outro motivo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(await screen.findByText(/OUTRO exige descrever/)).toBeDefined();
    expect(chamadas.length).toBe(0); // não viajou ao servidor

    fireEvent.click(screen.getByRole('button', { name: 'Chuva' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(await screen.findByText('Tarefa reagendada')).toBeDefined();
    expect(screen.getByText(/2026-07-09/)).toBeDefined();
    expect(screen.getByText('aguardando aprovação do gestor')).toBeDefined();
    expect(chamadas.length).toBe(1);
    expect(JSON.parse(chamadas[0]!)).toMatchObject({ motivo: 'CHUVA' });
  });

  it('vistoriador não vê o botão de justificar', async () => {
    mockJustificar('VISTORIADOR');
    renderTarefa();
    expect(await screen.findByText('Lavagem com água e detergente')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Não foi possível realizar' })).toBeNull();
  });
});

describe('partes (terminar outro dia)', () => {
  it('registra 50% e o ciclo de fotos recomeça na parte 2', async () => {
    let parteRegistrada = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/api/auth/me')) {
          return Promise.resolve(
            resposta(200, { id: 1, nome: 'T', login: 'x', role: 'EXECUTANTE', ativo: true }),
          );
        }
        if (u.includes('/partes') && init?.method === 'POST') {
          parteRegistrada = true;
          expect(JSON.parse(String(init.body))).toMatchObject({ percentualAcumulado: 50 });
          return Promise.resolve(resposta(201, { parte: 1, percentualAcumulado: 50, tempoSegParte: 600 }));
        }
        if (u.includes('/api/instancias/1')) {
          return Promise.resolve(
            resposta(
              200,
              parteRegistrada
                ? detalheBase({
                    fotos: [foto(1, 'ANTES'), foto(2, 'DEPOIS')],
                    partes: [
                      {
                        parte: 1,
                        percentualAcumulado: 50,
                        observacao: null,
                        executante: 'x',
                        criadoEm: '2026-07-08T18:00:00.000Z',
                      },
                    ],
                    parteCorrente: 2,
                  })
                : detalheBase({ fotos: [foto(1, 'ANTES'), foto(2, 'DEPOIS')] }),
            ),
          );
        }
        return Promise.resolve(resposta(404, { erro: 'não mockado' }));
      }),
    );

    renderTarefa();
    fireEvent.click(await screen.findByRole('button', { name: 'Terminar outro dia' }));
    fireEvent.click(await screen.findByRole('button', { name: '50%' }));
    fireEvent.click(screen.getByRole('button', { name: 'Registrar parte' }));

    // fotos da parte 1 saem do ciclo: a parte 2 pede um novo ANTES
    expect(await screen.findByRole('button', { name: /FOTOGRAFAR O ANTES/ })).toBeDefined();
    expect(screen.getByText(/Executada em partes/)).toBeDefined();
    expect(screen.queryByRole('button', { name: /CONCLUIR TAREFA/ })).toBeNull();
  });
});

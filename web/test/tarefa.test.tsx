// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppRoutes } from '../src/App';
import { formatarTempo } from '../src/pages/executante/Tarefa';
import { montarFormFoto } from '../src/lib/foto';
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
    status: 'PENDING',
    origin: 'CALENDAR',
    executanteLogin: null,
    limitacoes: null,
    metodo: 'Molhar, esfregar com detergente neutro e enxaguar bem.',
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

function mockCom(role: string, detalhe: unknown, concluirResposta?: { status: number; corpo: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/auth/me')) {
        return Promise.resolve(resposta(200, { id: 1, nome: 'T', login: 'x', role, ativo: true }));
      }
      if (u.includes('/concluir') && init?.method === 'POST') {
        const r = concluirResposta ?? { status: 200, corpo: {} };
        return Promise.resolve(resposta(r.status, r.corpo));
      }
      if (u.includes('/api/instancias/1')) return Promise.resolve(resposta(200, detalhe));
      return Promise.resolve(resposta(404, { erro: 'não mockado' }));
    }),
  );
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

describe('tela da tarefa (1 tarefa = 1 tela)', () => {
  it('PENDING sem fotos: botão gigante do ANTES e método vigente', async () => {
    mockCom('EXECUTANTE', detalheBase());
    renderTarefa();
    expect(await screen.findByRole('button', { name: /FOTOGRAFAR O ANTES/ })).toBeDefined();
    expect(screen.getByText('Como será feito')).toBeDefined();
    expect(screen.getByText('Lavagem com água e detergente')).toBeDefined();
  });

  it('com ANTES enviada: cronômetro correndo e botão do DEPOIS', async () => {
    mockCom(
      'EXECUTANTE',
      detalheBase({ status: 'IN_PROGRESS', executanteLogin: 'x', fotos: [foto(1, 'ANTES')] }),
    );
    renderTarefa();
    expect(await screen.findByRole('button', { name: /FOTOGRAFAR O DEPOIS/ })).toBeDefined();
    expect(screen.getByText(/⏱/)).toBeDefined();
    expect(screen.queryByRole('button', { name: /CONCLUIR/ })).toBeNull();
  });

  it('com ANTES+DEPOIS: concluir mostra a tela de sucesso com o tempo medido', async () => {
    mockCom(
      'EXECUTANTE',
      detalheBase({
        status: 'IN_PROGRESS',
        executanteLogin: 'x',
        fotos: [foto(1, 'ANTES'), foto(2, 'DEPOIS')],
      }),
      { status: 200, corpo: { statusFinal: 'DONE_ON_TIME', proximaDue: '2026-07-09', tempoExecucaoSeg: 600 } },
    );
    renderTarefa();
    fireEvent.click(await screen.findByRole('button', { name: /CONCLUIR TAREFA/ }));
    expect(await screen.findByText(/Tarefa concluída/)).toBeDefined();
    expect(screen.getByText(/10:00/)).toBeDefined();
    expect(screen.getByText(/2026-07-09/)).toBeDefined();
  });

  it('409 do backend aparece como está (a UI é casca)', async () => {
    mockCom(
      'EXECUTANTE',
      detalheBase({
        status: 'IN_PROGRESS',
        executanteLogin: 'x',
        fotos: [foto(1, 'ANTES'), foto(2, 'DEPOIS')],
      }),
      { status: 409, corpo: { erro: 'Menos de 5 min entre o ANTES e o DEPOIS — evidência recusada.' } },
    );
    renderTarefa();
    fireEvent.click(await screen.findByRole('button', { name: /CONCLUIR TAREFA/ }));
    expect(await screen.findByText(/Menos de 5 min/)).toBeDefined();
  });

  it('vistoriador lê mas não age; fechada mostra o tempo', async () => {
    mockCom(
      'VISTORIADOR',
      detalheBase({
        status: 'DONE_ON_TIME',
        fotos: [foto(1, 'ANTES'), foto(2, 'DEPOIS')],
        tempoExecucaoSeg: 3665,
      }),
    );
    renderTarefa();
    expect(await screen.findByText(/Tarefa fechada/)).toBeDefined();
    expect(screen.getByText(/1:01:05/)).toBeDefined();
    expect(screen.queryByRole('button', { name: /FOTOGRAFAR|CONCLUIR/ })).toBeNull();
  });
});

describe('pipeline do cliente (unidades)', () => {
  it('formatarTempo: mm:ss e h:mm:ss', () => {
    expect(formatarTempo(65)).toBe('01:05');
    expect(formatarTempo(600)).toBe('10:00');
    expect(formatarTempo(3665)).toBe('1:01:05');
  });

  it('montarFormFoto: EXIF do cliente vira campo do form; sem EXIF cai no relógio do device', () => {
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    const agora = new Date('2026-07-08T15:00:00.000Z');

    const com = montarFormFoto(
      'ANTES',
      blob,
      { capturedAt: '2026-07-08T14:55:00.000Z', exifDatetime: '2026-07-08T14:55:00.000Z', exifModel: 'Samsung SM-A155M' },
      agora,
    );
    expect(com.get('tipo')).toBe('ANTES');
    expect(com.get('capturedAt')).toBe('2026-07-08T14:55:00.000Z');
    expect(com.get('deviceNow')).toBe('2026-07-08T15:00:00.000Z');
    expect(com.get('exifModel')).toBe('Samsung SM-A155M');
    expect(com.get('arquivo')).toBeInstanceOf(Blob);

    const sem = montarFormFoto('DEPOIS', blob, {}, agora);
    expect(sem.get('capturedAt')).toBe('2026-07-08T15:00:00.000Z');
    expect(sem.get('exifDatetime')).toBeNull();
  });
});

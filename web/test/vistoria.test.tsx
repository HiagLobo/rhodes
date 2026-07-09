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

const ITEM_FILA = {
  id: 7,
  areaId: 1,
  areaNome: 'Silo 01',
  atividade: 'Varrição e remoção de resíduos',
  executanteLogin: 'executante.teste',
  status: 'DONE_ON_TIME',
  finishedAt: '2026-07-08T12:00:00.000Z',
  roundId: null,
  origin: 'CALENDAR',
  reworkOfInstanceId: null,
  tempoExecucaoSeg: 600,
  amostral: true,
};

function foto(id: number, tipo: string) {
  return {
    id,
    instanceId: 7,
    tipo,
    parte: 1,
    capturedAt: '2026-07-08T11:50:00.000Z',
    receivedAt: '2026-07-08T11:50:00.000Z',
    skewMs: 0,
    exifDatetime: null,
    exifModel: null,
    tamanhoBytes: 1000,
    enviadoPor: 'executante.teste',
  };
}

const DETALHE = {
  id: 7,
  templateId: 1,
  areaId: 1,
  areaNome: 'Silo 01',
  atividade: 'Varrição e remoção de resíduos',
  frequency: 'DIARIO',
  triggerType: 'CALENDAR',
  dueDate: '2026-07-08',
  windowEnd: '2026-07-08',
  status: 'DONE_ON_TIME',
  origin: 'CALENDAR',
  executanteLogin: 'executante.teste',
  limitacoes: null,
  metodo: 'Varrer do fundo para a porta.',
  minFotosIntervaloMin: 5,
  startedAt: null,
  finishedAt: '2026-07-08T12:00:00.000Z',
  fotos: [foto(1, 'ANTES'), foto(2, 'DEPOIS')],
  partes: [],
  parteCorrente: 1,
  tempoExecucaoSeg: 600,
  justificativa: null,
  inspecao: null,
};

function mockCom(
  role: string,
  opts: { decisao?: { status: number; corpo: unknown } } = {},
): Array<{ url: string; body: string }> {
  const chamadas: Array<{ url: string; body: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/auth/me')) {
        return Promise.resolve(resposta(200, { id: 9, nome: 'V', login: 'v', role, ativo: true }));
      }
      if ((u.includes('/aprovar') || u.includes('/reprovar')) && init?.method === 'POST') {
        chamadas.push({ url: u, body: String(init.body) });
        const r = opts.decisao ?? { status: 200, corpo: {} };
        return Promise.resolve(resposta(r.status, r.corpo));
      }
      if (u.includes('/api/vistoria/fila')) return Promise.resolve(resposta(200, [ITEM_FILA]));
      if (u.includes('/api/instancias/7')) return Promise.resolve(resposta(200, DETALHE));
      return Promise.resolve(resposta(404, { erro: 'não mockado' }));
    }),
  );
  return chamadas;
}

function renderRota(rota: string) {
  return render(
    <MantineProvider theme={theme}>
      <MemoryRouter initialEntries={[rota]}>
        <AppRoutes />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe('fila de vistoria', () => {
  it('lista com badge amostral, tempo e botão Inspecionar', async () => {
    mockCom('VISTORIADOR');
    renderRota('/vistoria');
    expect(await screen.findByText('Varrição e remoção de resíduos')).toBeDefined();
    expect(screen.getByText('⭐ AMOSTRAL')).toBeDefined();
    expect(screen.getByText(/10:00/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Inspecionar' })).toBeDefined();
  });
});

describe('inspeção', () => {
  it('mostra ANTES | DEPOIS, tempo e método; aprovar exige senha e assina', async () => {
    const chamadas = mockCom('VISTORIADOR', {
      decisao: { status: 200, corpo: { resultado: 'APROVADA', retrabalhoDue: null } },
    });
    renderRota('/vistoria/7');

    expect(await screen.findByText('ANTES')).toBeDefined();
    expect(screen.getByText('DEPOIS')).toBeDefined();
    expect(screen.getByText(/⏱ 10:00/)).toBeDefined();
    expect(screen.getByText('Como deveria ser feito')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /APROVAR/ }));
    const confirmar = await screen.findByRole('button', { name: 'Assinar e aprovar' });
    expect(confirmar).toHaveProperty('disabled', true); // sem senha não assina

    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'minha-senha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assinar e aprovar' }));
    expect(await screen.findByText(/Execução aprovada/)).toBeDefined();
    expect(chamadas.length).toBe(1);
    expect(JSON.parse(chamadas[0]!.body)).toMatchObject({ senha: 'minha-senha' });
  });

  it('reprovar exige motivo + severidade + senha e mostra o prazo do retrabalho', async () => {
    const chamadas = mockCom('VISTORIADOR', {
      decisao: {
        status: 200,
        corpo: { resultado: 'REPROVADA', retrabalhoDue: '2026-07-09' },
      },
    });
    renderRota('/vistoria/7');

    fireEvent.click(await screen.findByRole('button', { name: /REPROVAR/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mofo' }));
    fireEvent.click(screen.getByRole('button', { name: /Crítica/ }));
    fireEvent.change(screen.getByLabelText('Senha (assinatura)'), {
      target: { value: 'minha-senha' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Assinar e reprovar' }));

    expect(await screen.findByText(/Retrabalho gerado para 2026-07-09/)).toBeDefined();
    expect(JSON.parse(chamadas[0]!.body)).toMatchObject({ motivo: 'MOFO', severidade: 'CRITICA' });
  });

  it('senha errada: o 401 do backend aparece e a decisão não acontece', async () => {
    mockCom('VISTORIADOR', {
      decisao: { status: 401, corpo: { erro: 'Senha incorreta — a assinatura não confere.' } },
    });
    renderRota('/vistoria/7');
    fireEvent.click(await screen.findByRole('button', { name: /APROVAR/ }));
    fireEvent.change(await screen.findByLabelText('Senha'), { target: { value: 'errada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assinar e aprovar' }));
    expect((await screen.findAllByText(/assinatura não confere/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Execução aprovada/)).toBeNull();
  });

  it('executante não vê botões de decisão', async () => {
    mockCom('EXECUTANTE');
    renderRota('/vistoria/7');
    expect(await screen.findByText('ANTES')).toBeDefined();
    expect(screen.queryByRole('button', { name: /APROVAR/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /REPROVAR/ })).toBeNull();
  });
});

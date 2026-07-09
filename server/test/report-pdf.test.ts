import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { DossieDados, FotoEvidenciaDossie, ScoreResultado } from '@rhodes/shared';

import {
  placeholderIndisponivel,
  resolverImagemExibicao,
  type ImagemExibicao,
} from '../src/services/report/imagem-exibicao.js';
import { agruparFotosPorParte } from '../src/services/report/pdf-layout.js';
import { gerarDossiePdf } from '../src/services/report/pdf.js';

function coletor(): { stream: Writable; buffer: () => Buffer } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  return { stream, buffer: () => Buffer.concat(chunks) };
}

async function jpegFake(): Promise<Buffer> {
  return sharp({ create: { width: 24, height: 18, channels: 3, background: '#8899aa' } }).jpeg().toBuffer();
}

const carregarOk = async (): Promise<ImagemExibicao> => ({ buffer: await jpegFake(), presente: true });
const carregarPlaceholder = async (): Promise<ImagemExibicao> => ({ buffer: await jpegFake(), presente: false });

const score: ScoreResultado = {
  score: 82,
  banda: 'ATENCAO',
  componentes: {
    pontualidade: { valor: 0.8, n: 4 },
    aprovacao: { valor: 1, n: 2 },
    cobertura: { valor: 0.9, n: 6 },
  },
  demeritos: 0,
  n: 4,
  incertezaMais: 6,
  incertezaMenos: 6,
  taxaJustificadas: 0,
  areas: [],
};

function foto(id: number, tipo: string, sha: string): FotoEvidenciaDossie {
  return {
    id,
    tipo,
    parte: 1,
    sha256: sha,
    receivedAt: '2026-06-10T09:00:00.000Z',
    capturedAt: '2026-06-10T08:58:00.000Z',
    skewMs: 0,
  };
}

function dossieFake(): DossieDados {
  return {
    periodo: { inicio: '2026-06-01', fim: '2026-06-30' },
    geradoEm: '2026-07-09T12:00:00.000Z',
    responsaveis: ['exec.a', 'vist.a'],
    areas: [{ id: 1, nome: 'Moega de Recepção', peso: 2 }],
    score,
    coberturaSnapshot: false,
    conformidade: [
      { areaId: 1, areaNome: 'Moega de Recepção', noPrazo: 1, atrasadas: 0, justificadas: 0, perdidas: 1, emAberto: 1, total: 3 },
    ],
    paginas: [
      {
        instanceId: 10,
        areaId: 1,
        areaNome: 'Moega de Recepção',
        atividade: 'Varrição e aspiração da moega',
        frequency: 'DIARIA',
        intervalDays: 1,
        dueDate: '2026-06-10',
        windowEnd: '2026-06-10',
        statusFinal: 'DONE_LATE',
        conformidade: 'ATRASADA',
        executante: 'exec.a',
        finishedAt: '2026-06-11T14:00:00.000Z',
        tempoExecucaoSeg: 1500,
        metodoVersao: 'POP-01: varrer, aspirar e conferir cantos.',
        fotos: [foto(1, 'ANTES', 'a1b2c3d4e5f6'), foto(2, 'DEPOIS', 'f6e5d4c3b2a1')],
        inspecao: {
          resultado: 'REPROVADA',
          vistoriador: 'vist.a',
          criadoEm: '2026-06-11T16:00:00.000Z',
          severidade: 'MAIOR',
          motivo: 'SUJEIRA_RESIDUAL',
          texto: 'restou pó no canto sudeste',
          amostral: false,
        },
        navioLote: { roundId: 7, navio: 'MV BOA VIAGEM', produto: 'MILHO', tonelagem: 48000, etaDate: '2026-06-09' },
      },
      {
        instanceId: 11,
        areaId: 1,
        areaNome: 'Moega de Recepção',
        atividade: 'Inspeção de redler',
        frequency: 'SEMANAL',
        intervalDays: 7,
        dueDate: '2026-06-15',
        windowEnd: '2026-06-16',
        statusFinal: 'PENDING',
        conformidade: 'EM_ABERTO',
        executante: null,
        finishedAt: null,
        tempoExecucaoSeg: null,
        metodoVersao: null,
        fotos: [],
        inspecao: null,
        navioLote: null,
      },
    ],
    justificativas: [
      {
        areaNome: 'Moega de Recepção',
        atividade: 'Lavagem externa',
        motivo: 'CHUVA',
        texto: 'chuva forte o dia inteiro',
        status: 'APROVADA',
        criadoEm: '2026-06-12T10:00:00.000Z',
        decididoPor: 'gestor.a',
      },
    ],
    hash: 'deadbeefcafef00d1234567890abcdef1234567890abcdef1234567890abcdef',
  };
}

describe('gerarDossiePdf', () => {
  it('produz um PDF válido (magic bytes) em streaming e conta as páginas de evidência', async () => {
    const { stream, buffer } = coletor();
    const resumo = await gerarDossiePdf(dossieFake(), carregarOk, stream);
    const buf = buffer();
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buf.subarray(-8).toString('latin1')).toContain('%%EOF');
    // uma entrada de evidência por instância; todas as fotos REAIS foram embutidas
    expect(resumo.paginasEvidencia).toBe(2);
    expect(resumo.sha256Usados.sort()).toEqual(['a1b2c3d4e5f6', 'f6e5d4c3b2a1']);
    expect(resumo.sha256Ausentes).toEqual([]);
  });

  it('tem ao menos capa + tabela + 1 evidência (contagem estrutural de páginas)', async () => {
    const { stream, buffer } = coletor();
    await gerarDossiePdf(dossieFake(), carregarOk, stream, { comprimir: false });
    const str = buffer().toString('latin1');
    const paginas = (str.match(/\/Type\s*\/Page(?![s])/g) ?? []).length;
    expect(paginas).toBeGreaterThanOrEqual(4); // capa + conformidade + 2 evidências (+ anexo)
  });

  it('não vaza caminho de filesystem (path/thumb) no PDF', async () => {
    const { stream, buffer } = coletor();
    await gerarDossiePdf(dossieFake(), carregarOk, stream, { comprimir: false });
    const str = buffer().toString('latin1');
    expect(str.includes('/fotos/')).toBe(false);
    expect(str.includes('.thumb.jpg')).toBe(false);
  });

  it('manifesto honesto: placeholder conta como AUSENTE, não como evidência embutida (ALCOA+)', async () => {
    const { stream } = coletor();
    const resumo = await gerarDossiePdf(dossieFake(), carregarPlaceholder, stream);
    expect(resumo.sha256Usados).toEqual([]);
    expect(resumo.sha256Ausentes.sort()).toEqual(['a1b2c3d4e5f6', 'f6e5d4c3b2a1']);
  });

  it('não quebra quando o carregador de imagem rejeita; as fotos entram em AUSENTES', async () => {
    const { stream, buffer } = coletor();
    const resumo = await gerarDossiePdf(dossieFake(), () => Promise.reject(new Error('disco fora')), stream);
    const buf = buffer();
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(resumo.paginasEvidencia).toBe(2);
    expect(resumo.sha256Usados).toEqual([]);
    expect(resumo.sha256Ausentes.sort()).toEqual(['a1b2c3d4e5f6', 'f6e5d4c3b2a1']);
  });

  it('gera um PDF válido mesmo sem páginas (período vazio)', async () => {
    const vazio = { ...dossieFake(), paginas: [], conformidade: [], justificativas: [], score: { ...score, score: null, banda: null } };
    const { stream, buffer } = coletor();
    const resumo = await gerarDossiePdf(vazio, carregarOk, stream);
    expect(buffer().subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(resumo.paginasEvidencia).toBe(0);
  });

  it('destino destruído no meio (abort do cliente) → rejeita sem derrubar o processo', async () => {
    const pass = new PassThrough();
    pass.on('data', () => {
      if (!pass.destroyed) pass.destroy(); // simula o cliente abortando ao receber os primeiros bytes
    });
    // O handler passivo de `finalizado` evita a unhandled rejection (que no Node 24 mataria o processo);
    // a geração termina rejeitando de forma controlada.
    await expect(gerarDossiePdf(dossieFake(), carregarOk, pass)).rejects.toBeDefined();
  });
});

describe('agruparFotosPorParte (pareamento ANTES/DEPOIS por parte, não por índice)', () => {
  it('casa antes/depois da MESMA parte mesmo com ids fora de ordem', () => {
    // Ordem de photos.id embaralhada: A1, A2, D2, D1 (D da parte 2 antes do D da parte 1)
    const fotos = [
      foto(1, 'ANTES', 'A1'),
      { ...foto(2, 'ANTES', 'A2'), parte: 2 },
      { ...foto(3, 'DEPOIS', 'D2'), parte: 2 },
      foto(4, 'DEPOIS', 'D1'),
    ];
    const grupos = agruparFotosPorParte(fotos);
    expect(grupos.map((g) => g.parte)).toEqual([1, 2]);
    expect(grupos[0]!.antes.map((f) => f.sha256)).toEqual(['A1']);
    expect(grupos[0]!.depois.map((f) => f.sha256)).toEqual(['D1']); // D1 casa com A1 (parte 1)
    expect(grupos[1]!.antes.map((f) => f.sha256)).toEqual(['A2']);
    expect(grupos[1]!.depois.map((f) => f.sha256)).toEqual(['D2']); // D2 casa com A2 (parte 2)
  });

  it('separa IMPEDIMENTO em outras', () => {
    const grupos = agruparFotosPorParte([foto(1, 'ANTES', 'a'), foto(2, 'IMPEDIMENTO', 'i')]);
    expect(grupos[0]!.antes.map((f) => f.sha256)).toEqual(['a']);
    expect(grupos[0]!.outras.map((f) => f.sha256)).toEqual(['i']);
  });
});

describe('resolverImagemExibicao', () => {
  it('redimensiona o original para uma cópia JPEG (não o binário cru)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-img-'));
    const rel = path.join('fotos', '2026', '06', 'orig.jpg');
    fs.mkdirSync(path.join(dir, 'fotos', '2026', '06'), { recursive: true });
    const original = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: '#334455' } })
      .jpeg({ quality: 95 })
      .toBuffer();
    fs.writeFileSync(path.join(dir, rel), original);

    const saida = await resolverImagemExibicao(dir, rel);
    expect(saida.presente).toBe(true);
    expect(saida.buffer.subarray(0, 2).toString('hex')).toBe('ffd8'); // JPEG
    const meta = await sharp(saida.buffer).metadata();
    expect(meta.width).toBe(900); // reduzido para a largura de exibição
    expect(saida.buffer.length).toBeLessThan(original.length);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('devolve placeholder JPEG e presente=false quando o arquivo não existe (dossiê não quebra)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-img-'));
    const saida = await resolverImagemExibicao(dir, path.join('fotos', 'inexistente.jpg'));
    expect(saida.presente).toBe(false);
    expect(saida.buffer.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(saida.buffer.length).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('placeholderIndisponivel é um JPEG válido', async () => {
    const buf = await placeholderIndisponivel();
    expect(buf.subarray(0, 2).toString('hex')).toBe('ffd8');
  });
});

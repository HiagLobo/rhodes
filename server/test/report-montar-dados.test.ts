import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  dataRecife,
  relatorioFiltrosSchema,
  somarDias,
  type DossieDados,
  type RelatorioFiltros,
  type ScoreResultado,
} from '@rhodes/shared';

import { createDb, runMigrations, type Db } from '../src/db/index.js';
import { inspections, shipOperations, taskInstances } from '../src/db/schema.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { seedDev } from '../src/db/seed.js';
import { hashCanonico } from '../src/services/report/hash-canonico.js';
import { classificarConformidade, montarDossieDados } from '../src/services/report/montar-dados.js';
import { coletarEventos, coletarEventosEntre } from '../src/services/score/coletar.js';
import { lerScoreConfig } from '../src/services/score/config.js';
import { calcularScore } from '../src/services/score/engine.js';
import { dailyJob } from '../src/services/scheduler/daily-job.js';
import { onComplete } from '../src/services/scheduler/on-complete.js';

import type DatabaseType from 'better-sqlite3';

type Ctx = { db: Db; sqlite: DatabaseType.Database };
const abertos: Ctx[] = [];

async function novoBanco(): Promise<Ctx> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-report-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  await seedDev(db);
  seedCatalogo(db);
  dailyJob(db, new Date());
  const ctx = { db, sqlite };
  abertos.push(ctx);
  return ctx;
}

afterEach(() => {
  while (abertos.length) abertos.pop()!.sqlite.close();
});

function ator(sqlite: DatabaseType.Database, role: string): { id: number; login: string } {
  return sqlite.prepare('SELECT id, login FROM users WHERE role=? LIMIT 1').get(role) as {
    id: number;
    login: string;
  };
}

function algumTemplateId(sqlite: DatabaseType.Database): number {
  return (sqlite.prepare('SELECT id FROM task_templates LIMIT 1').get() as { id: number }).id;
}

function periodoAteHoje(dias = 30): RelatorioFiltros {
  const hoje = dataRecife(new Date());
  return { inicio: somarDias(hoje, -dias), fim: hoje, somenteReprovadasOuCriticas: false };
}

describe('classificarConformidade (puro)', () => {
  it('mapeia os 6 INSTANCE_STATUS', () => {
    expect(classificarConformidade('DONE_ON_TIME', false)).toBe('NO_PRAZO');
    expect(classificarConformidade('DONE_LATE', false)).toBe('ATRASADA');
    expect(classificarConformidade('MISSED', true)).toBe('JUSTIFICADA');
    expect(classificarConformidade('MISSED', false)).toBe('PERDIDA');
    expect(classificarConformidade('PENDING', false)).toBe('EM_ABERTO');
    expect(classificarConformidade('IN_PROGRESS', false)).toBe('EM_ABERTO');
    expect(classificarConformidade('OVERDUE', false)).toBe('EM_ABERTO');
  });
});

describe('montarDossieDados', () => {
  it('conformidade reconcilia por área e o total = nº de páginas (sem filtro)', async () => {
    const { db, sqlite } = await novoBanco();
    const hoje = dataRecife(new Date());
    // Puxa todas as instâncias semeadas para a janela (dueDate = hoje).
    sqlite.prepare('UPDATE task_instances SET due_date=?, window_end=?').run(hoje, hoje);
    const exec = ator(sqlite, 'EXECUTANTE');
    const abertasIds = sqlite
      .prepare("SELECT id FROM task_instances WHERE status='PENDING' LIMIT 3")
      .all() as { id: number }[];
    for (const a of abertasIds) onComplete(db, a.id, exec, new Date());

    const dados = montarDossieDados(db, periodoAteHoje(), new Date());
    let soma = 0;
    for (const c of dados.conformidade) {
      expect(c.noPrazo + c.atrasadas + c.justificadas + c.perdidas + c.emAberto).toBe(c.total);
      soma += c.total;
    }
    expect(dados.paginas.length).toBeGreaterThan(0);
    expect(soma).toBe(dados.paginas.length);
  });

  it('score do período usa coletarEventosEntre', async () => {
    const { db } = await novoBanco();
    const filtros = periodoAteHoje();
    const dados = montarDossieDados(db, filtros, new Date());
    const esperado = calcularScore(
      coletarEventosEntre(db, filtros.inicio, filtros.fim),
      lerScoreConfig(db),
    );
    expect(dados.score.score).toBe(esperado.score);
    expect(dados.score.areas.length).toBe(esperado.areas.length);
  });

  it('página de instância-retrabalho mantém a inspeção (dossiê não aplica filtro reworkOf)', async () => {
    const { db, sqlite } = await novoBanco();
    const hoje = dataRecife(new Date());
    const tpl = algumTemplateId(sqlite);
    const vist = ator(sqlite, 'VISTORIADOR');
    const orig = db
      .insert(taskInstances)
      .values({ templateId: tpl, dueDate: hoje, windowEnd: hoje, status: 'DONE_LATE', origin: 'CALENDAR' })
      .returning()
      .get();
    const rework = db
      .insert(taskInstances)
      .values({
        templateId: tpl,
        dueDate: hoje,
        windowEnd: hoje,
        status: 'DONE_ON_TIME',
        origin: 'CALENDAR',
        reworkOfInstanceId: orig.id,
      })
      .returning()
      .get();
    db.insert(inspections).values({ instanceId: rework.id, resultado: 'APROVADA', vistoriadorId: vist.id }).run();

    const dados = montarDossieDados(
      db,
      { inicio: somarDias(hoje, -1), fim: hoje, somenteReprovadasOuCriticas: false },
      new Date(),
    );
    const pag = dados.paginas.find((p) => p.instanceId === rework.id);
    expect(pag).toBeDefined();
    expect(pag!.inspecao).not.toBeNull();
    expect(pag!.inspecao!.resultado).toBe('APROVADA');
  });

  it('navio/lote resolvido para SHIP (produto = "lote") e null para CALENDAR', async () => {
    const { db, sqlite } = await novoBanco();
    const hoje = dataRecife(new Date());
    const tpl = algumTemplateId(sqlite);
    const gestor = ator(sqlite, 'GESTOR');
    const ship = db
      .insert(shipOperations)
      .values({ navio: 'MV TESTE', produto: 'MILHO', tonelagem: 50000, etaDate: hoje, criadoPorId: gestor.id })
      .returning()
      .get();
    const comNavio = db
      .insert(taskInstances)
      .values({ templateId: tpl, dueDate: hoje, windowEnd: hoje, status: 'DONE_ON_TIME', origin: 'SHIP', roundId: ship.id })
      .returning()
      .get();
    const semNavio = db
      .insert(taskInstances)
      .values({ templateId: tpl, dueDate: hoje, windowEnd: hoje, status: 'DONE_ON_TIME', origin: 'CALENDAR' })
      .returning()
      .get();

    const dados = montarDossieDados(
      db,
      { inicio: somarDias(hoje, -1), fim: hoje, somenteReprovadasOuCriticas: false },
      new Date(),
    );
    const pNavio = dados.paginas.find((p) => p.instanceId === comNavio.id)!;
    const pSem = dados.paginas.find((p) => p.instanceId === semNavio.id)!;
    expect(pNavio.navioLote).toEqual({
      roundId: ship.id,
      navio: 'MV TESTE',
      produto: 'MILHO',
      tonelagem: 50000,
      etaDate: hoje,
    });
    expect(pSem.navioLote).toBeNull();

    // Filtro por RODADA: o dossiê traz só as instâncias daquela rodada, com o vínculo navio/lote.
    const daRodada = montarDossieDados(
      db,
      { inicio: somarDias(hoje, -1), fim: hoje, roundId: ship.id, somenteReprovadasOuCriticas: false },
      new Date(),
    );
    expect(daRodada.paginas.length).toBe(1);
    expect(daRodada.paginas[0]!.instanceId).toBe(comNavio.id);
    expect(daRodada.paginas[0]!.navioLote?.navio).toBe('MV TESTE');
  });

  it('somenteReprovadasOuCriticas mantém só páginas reprovadas/críticas', async () => {
    const { db, sqlite } = await novoBanco();
    const hoje = dataRecife(new Date());
    const tpl = algumTemplateId(sqlite);
    const vist = ator(sqlite, 'VISTORIADOR');
    const reprovada = db
      .insert(taskInstances)
      .values({ templateId: tpl, dueDate: hoje, windowEnd: hoje, status: 'DONE_LATE', origin: 'CALENDAR' })
      .returning()
      .get();
    const aprovada = db
      .insert(taskInstances)
      .values({ templateId: tpl, dueDate: hoje, windowEnd: hoje, status: 'DONE_ON_TIME', origin: 'CALENDAR' })
      .returning()
      .get();
    db.insert(inspections)
      .values({ instanceId: reprovada.id, resultado: 'REPROVADA', severidade: 'MAIOR', vistoriadorId: vist.id })
      .run();
    db.insert(inspections).values({ instanceId: aprovada.id, resultado: 'APROVADA', vistoriadorId: vist.id }).run();

    const dados = montarDossieDados(
      db,
      { inicio: somarDias(hoje, -1), fim: hoje, somenteReprovadasOuCriticas: true },
      new Date(),
    );
    expect(dados.paginas.length).toBeGreaterThan(0);
    for (const p of dados.paginas) {
      expect(p.inspecao?.resultado === 'REPROVADA' || p.inspecao?.severidade === 'CRITICA').toBe(true);
    }
    expect(dados.paginas.some((p) => p.instanceId === aprovada.id)).toBe(false);
  });

  it('instância em aberto sem fotos → tempoExecucaoSeg null e EM_ABERTO', async () => {
    const { db, sqlite } = await novoBanco();
    const hoje = dataRecife(new Date());
    sqlite.prepare('UPDATE task_instances SET due_date=?, window_end=?').run(hoje, hoje);
    const dados = montarDossieDados(
      db,
      { inicio: somarDias(hoje, -1), fim: hoje, somenteReprovadasOuCriticas: false },
      new Date(),
    );
    const aberta = dados.paginas.find((p) => p.statusFinal === 'PENDING');
    expect(aberta).toBeDefined();
    expect(aberta!.tempoExecucaoSeg).toBeNull();
    expect(aberta!.conformidade).toBe('EM_ABERTO');
  });

  it('filtro areaIds estreita páginas, áreas E o score (coerência do escopo)', async () => {
    const { db, sqlite } = await novoBanco();
    const hoje = dataRecife(new Date());
    sqlite.prepare('UPDATE task_instances SET due_date=?, window_end=?').run(hoje, hoje);
    const areasComInst = sqlite
      .prepare(
        'SELECT DISTINCT tt.area_id AS areaId FROM task_instances ti JOIN task_templates tt ON tt.id=ti.template_id',
      )
      .all() as { areaId: number }[];
    expect(areasComInst.length).toBeGreaterThan(1); // seed cobre várias áreas
    const areaX = areasComInst[0]!.areaId;

    const filtros: RelatorioFiltros = {
      inicio: somarDias(hoje, -1),
      fim: hoje,
      areaIds: [areaX],
      somenteReprovadasOuCriticas: false,
    };
    const dados = montarDossieDados(db, filtros, new Date());
    expect(dados.paginas.length).toBeGreaterThan(0);
    expect(dados.paginas.every((p) => p.areaId === areaX)).toBe(true);
    expect(dados.areas.every((a) => a.id === areaX)).toBe(true);
    // o score também é escopado à área — score.areas não traz áreas fora do filtro
    expect(dados.score.areas.every((a) => a.areaId === areaX)).toBe(true);

    const global = montarDossieDados(
      db,
      { inicio: somarDias(hoje, -1), fim: hoje, somenteReprovadasOuCriticas: false },
      new Date(),
    );
    expect(global.score.areas.length).toBeGreaterThan(dados.score.areas.length);
  });

  it('hash é determinístico entre gerações (geradoEm difere, hash igual)', async () => {
    const { db } = await novoBanco();
    const filtros = periodoAteHoje();
    const d1 = montarDossieDados(db, filtros, new Date('2026-07-09T10:00:00Z'));
    const d2 = montarDossieDados(db, filtros, new Date('2026-07-09T18:30:00Z'));
    expect(d1.geradoEm).not.toBe(d2.geradoEm);
    expect(d1.hash).toBe(d2.hash);
  });
});

describe('coletarEventosEntre — compat com a Onda 08', () => {
  it('coletarEventos(30) === coletarEventosEntre(hoje-30, hoje)', async () => {
    const { db } = await novoBanco();
    const agora = new Date();
    const hoje = dataRecife(agora);
    const viaJanela = coletarEventos(db, 30, agora);
    const viaRange = coletarEventosEntre(db, somarDias(hoje, -30), hoje);
    expect(viaJanela.instancias).toEqual(viaRange.instancias);
    expect(viaJanela.inspecoes).toEqual(viaRange.inspecoes);
    expect(viaJanela.demeritos).toEqual(viaRange.demeritos);
    expect(viaJanela.templatesAtivos).toEqual(viaRange.templatesAtivos);
    expect(viaJanela.areas).toEqual(viaRange.areas);
    expect([...viaJanela.templatesComVencidaAberta].sort()).toEqual(
      [...viaRange.templatesComVencidaAberta].sort(),
    );
  });

  it('reflete conclusões concretas e escopa por área (não-tautológico)', async () => {
    const { db, sqlite } = await novoBanco();
    const hoje = dataRecife(new Date());
    sqlite.prepare('UPDATE task_instances SET due_date=?, window_end=?').run(hoje, hoje);
    const exec = ator(sqlite, 'EXECUTANTE');
    const alvo = sqlite
      .prepare(
        "SELECT ti.id AS id, tt.area_id AS areaId FROM task_instances ti JOIN task_templates tt ON tt.id=ti.template_id WHERE ti.status='PENDING' LIMIT 1",
      )
      .get() as { id: number; areaId: number };
    onComplete(db, alvo.id, exec, new Date());

    // concreto: a instância concluída HOJE aparece na janela [hoje, hoje] como DONE_ON_TIME
    const doDia = coletarEventosEntre(db, hoje, hoje);
    expect(doDia.instancias.some((i) => i.status === 'DONE_ON_TIME')).toBe(true);

    // escopo por área: só eventos/áreas da área alvo
    const escopado = coletarEventosEntre(db, hoje, hoje, [alvo.areaId]);
    expect(escopado.instancias.every((i) => i.areaId === alvo.areaId)).toBe(true);
    expect(escopado.areas.every((a) => a.areaId === alvo.areaId)).toBe(true);
  });
});

describe('hashCanonico (puro)', () => {
  const scoreSintetico: ScoreResultado = {
    score: 80,
    banda: 'ATENCAO',
    componentes: {
      pontualidade: { valor: 0.8, n: 5 },
      aprovacao: { valor: 1, n: 3 },
      cobertura: { valor: 0.9, n: 10 },
    },
    demeritos: 0,
    n: 5,
    incertezaMais: 5,
    incertezaMenos: 5,
    taxaJustificadas: 0,
    areas: [],
  };

  function sinteticoSemHash(): Omit<DossieDados, 'hash'> {
    return {
      periodo: { inicio: '2026-06-01', fim: '2026-06-30' },
      geradoEm: '2026-07-09T00:00:00.000Z',
      responsaveis: ['exec.a'],
      areas: [{ id: 1, nome: 'Moega', peso: 1 }],
      score: scoreSintetico,
      coberturaSnapshot: false,
      conformidade: [
        { areaId: 1, areaNome: 'Moega', noPrazo: 1, atrasadas: 0, justificadas: 0, perdidas: 0, emAberto: 0, total: 1 },
      ],
      paginas: [
        {
          instanceId: 1,
          areaId: 1,
          areaNome: 'Moega',
          atividade: 'Limpar',
          frequency: 'DIARIA',
          intervalDays: 1,
          dueDate: '2026-06-10',
          windowEnd: '2026-06-10',
          statusFinal: 'DONE_ON_TIME',
          conformidade: 'NO_PRAZO',
          executante: 'exec.a',
          finishedAt: '2026-06-10T10:00:00.000Z',
          tempoExecucaoSeg: 600,
          metodoVersao: 'POP',
          fotos: [
            { id: 1, tipo: 'ANTES', parte: 1, sha256: 'aaa', receivedAt: '2026-06-10T09:00:00.000Z', capturedAt: '2026-06-10T08:59:00.000Z', skewMs: 0 },
          ],
          inspecao: {
            resultado: 'REPROVADA',
            vistoriador: 'vist.a',
            criadoEm: '2026-06-10T11:00:00.000Z',
            severidade: 'MAIOR',
            motivo: 'SUJEIRA',
            texto: 'faltou limpar o canto',
            amostral: false,
          },
          navioLote: { roundId: 7, navio: 'MV X', produto: 'MILHO', tonelagem: 1000, etaDate: '2026-06-09' },
        },
      ],
      justificativas: [],
    };
  }

  const filtros: RelatorioFiltros = { inicio: '2026-06-01', fim: '2026-06-30', somenteReprovadasOuCriticas: false };

  it('é determinístico e ignora geradoEm', () => {
    const base = sinteticoSemHash();
    const h1 = hashCanonico(base, filtros);
    expect(hashCanonico(structuredClone(base), filtros)).toBe(h1);
    const outraData = structuredClone(base);
    outraData.geradoEm = '2030-01-01T00:00:00.000Z';
    expect(hashCanonico(outraData, filtros)).toBe(h1);
  });

  it('muda quando a evidência (sha256 da foto) muda', () => {
    const base = sinteticoSemHash();
    const h1 = hashCanonico(base, filtros);
    const mut = structuredClone(base);
    mut.paginas[0]!.fotos[0]!.sha256 = 'deadbeef';
    expect(hashCanonico(mut, filtros)).not.toBe(h1);
  });

  it('muda quando a severidade da vistoria muda (campo probatório impresso)', () => {
    const base = sinteticoSemHash();
    const h1 = hashCanonico(base, filtros);
    const mut = structuredClone(base);
    mut.paginas[0]!.inspecao!.severidade = 'CRITICA';
    expect(hashCanonico(mut, filtros)).not.toBe(h1);
  });

  it('muda quando a tonelagem do navio/lote muda', () => {
    const base = sinteticoSemHash();
    const h1 = hashCanonico(base, filtros);
    const mut = structuredClone(base);
    mut.paginas[0]!.navioLote!.tonelagem = 2000;
    expect(hashCanonico(mut, filtros)).not.toBe(h1);
  });

  it('areaIds=[] e ausente produzem o MESMO hash (mesmo escopo)', () => {
    const base = sinteticoSemHash();
    const semFiltro: RelatorioFiltros = { inicio: '2026-06-01', fim: '2026-06-30', somenteReprovadasOuCriticas: false };
    const arrayVazio: RelatorioFiltros = { ...semFiltro, areaIds: [] };
    expect(hashCanonico(base, arrayVazio)).toBe(hashCanonico(base, semFiltro));
  });
});

describe('relatorioFiltrosSchema (borda)', () => {
  it('rejeita fim<inicio e período > 186 dias', () => {
    expect(relatorioFiltrosSchema.safeParse({ inicio: '2026-07-09', fim: '2026-07-01' }).success).toBe(false);
    expect(relatorioFiltrosSchema.safeParse({ inicio: '2026-01-01', fim: '2026-12-31' }).success).toBe(false);
  });

  it('boolean da querystring: "false" NÃO vira true; "true" vira true; ausente = false', () => {
    const f = relatorioFiltrosSchema.safeParse({ inicio: '2026-06-01', fim: '2026-06-30', somenteReprovadasOuCriticas: 'false' });
    expect(f.success && f.data.somenteReprovadasOuCriticas).toBe(false);
    const t = relatorioFiltrosSchema.safeParse({ inicio: '2026-06-01', fim: '2026-06-30', somenteReprovadasOuCriticas: 'true' });
    expect(t.success && t.data.somenteReprovadasOuCriticas).toBe(true);
    const ausente = relatorioFiltrosSchema.safeParse({ inicio: '2026-06-01', fim: '2026-06-30' });
    expect(ausente.success && ausente.data.somenteReprovadasOuCriticas).toBe(false);
  });

  it('areaIds aceita CSV da querystring', () => {
    const r = relatorioFiltrosSchema.safeParse({ inicio: '2026-06-01', fim: '2026-06-30', areaIds: '1,2,3' });
    expect(r.success && r.data.areaIds).toEqual([1, 2, 3]);
  });
});

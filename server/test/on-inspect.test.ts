import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { dataRecife, somarDias } from '@rhodes/shared';

import { createDb, runMigrations, type Db } from '../src/db/index.js';
import { seedCatalogo } from '../src/db/seed-catalogo.js';
import { seedDev } from '../src/db/seed.js';
import { dailyJob } from '../src/services/scheduler/daily-job.js';
import { onComplete } from '../src/services/scheduler/on-complete.js';
import {
  InspecaoInvalidaError,
  onInspect,
  SegregacaoError,
} from '../src/services/scheduler/on-inspect.js';

import type DatabaseType from 'better-sqlite3';

type Ctx = { db: Db; sqlite: DatabaseType.Database };

let ctx: Ctx;
let exec: { id: number; login: string };
let vist: { id: number; login: string };

function usuario(login: string): { id: number; login: string } {
  const u = ctx.sqlite.prepare('SELECT id FROM users WHERE login = ?').get(login) as {
    id: number;
  };
  return { id: u.id, login };
}

/** Instância aberta de um template com o intervalo pedido, já CONCLUÍDA pelo executante. */
function executada(filtroIntervalo: string): { instanciaId: number; templateId: number } {
  const row = ctx.sqlite
    .prepare(
      `SELECT ti.id, ti.template_id AS templateId FROM task_instances ti
       JOIN task_templates tt ON tt.id = ti.template_id
       WHERE ti.status = 'PENDING' AND tt.interval_days ${filtroIntervalo}
         AND tt.trigger_type != 'SHIP_EVENT'
       ORDER BY ti.id LIMIT 1`,
    )
    .get() as { id: number; templateId: number };
  onComplete(ctx.db, row.id, exec, new Date());
  return { instanciaId: row.id, templateId: row.templateId };
}

function abertaDo(templateId: number): { id: number; due_date: string; rework_of_instance_id: number | null } | undefined {
  return ctx.sqlite
    .prepare(
      `SELECT id, due_date, rework_of_instance_id FROM task_instances
       WHERE template_id = ? AND status IN ('PENDING','IN_PROGRESS','OVERDUE')`,
    )
    .get(templateId) as never;
}

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-inspect-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  await seedDev(db);
  seedCatalogo(db);
  dailyJob(db, new Date());
  ctx = { db, sqlite };
  exec = usuario('executante.teste');
  vist = usuario('vistoriador.teste');
});

describe('onInspect — aprovar', () => {
  it('grava inspeção imutável e audita EXECUCAO_APROVADA', () => {
    const { instanciaId } = executada('= 1');
    const r = onInspect(ctx.db, instanciaId, { resultado: 'APROVADA' }, vist, new Date());
    expect(r.inspecao.resultado).toBe('APROVADA');
    expect(r.retrabalho).toBeNull();

    const auditoria = ctx.sqlite
      .prepare("SELECT depois FROM audit_log WHERE acao = 'EXECUCAO_APROVADA'")
      .get() as { depois: string };
    expect(JSON.parse(auditoria.depois)).toMatchObject({ resultado: 'APROVADA' });

    // 2ª inspeção da mesma execução → erro
    expect(() =>
      onInspect(ctx.db, instanciaId, { resultado: 'APROVADA' }, vist, new Date()),
    ).toThrow(InspecaoInvalidaError);
  });

  it('segregação: quem executou não vistoria; instância aberta não se vistoria', () => {
    const { instanciaId } = executada('= 1');
    expect(() =>
      onInspect(ctx.db, instanciaId, { resultado: 'APROVADA' }, exec, new Date()),
    ).toThrow(SegregacaoError);

    const aberta = ctx.sqlite
      .prepare("SELECT id FROM task_instances WHERE status = 'PENDING' LIMIT 1")
      .get() as { id: number };
    expect(() =>
      onInspect(ctx.db, aberta.id, { resultado: 'APROVADA' }, vist, new Date()),
    ).toThrow(/concluídas/);
  });
});

describe('onInspect — reprovar gera retrabalho', () => {
  it('CRITICA antecipa a próxima aberta para hoje+1 e vincula (nunca duplica)', () => {
    // template com intervalo ≥7: a próxima gerada pelo onComplete vence longe → dá para antecipar
    const { instanciaId, templateId } = executada('>= 7');
    const antes = abertaDo(templateId)!;
    expect(antes.due_date > somarDias(dataRecife(new Date()), 1)).toBe(true);

    const r = onInspect(
      ctx.db,
      instanciaId,
      { resultado: 'REPROVADA', motivo: 'MOFO', severidade: 'CRITICA' },
      vist,
      new Date(),
    );
    const depois = abertaDo(templateId)!;
    expect(depois.id).toBe(antes.id); // ANTECIPADA, não recriada
    expect(depois.due_date).toBe(somarDias(dataRecife(new Date()), 1));
    expect(depois.rework_of_instance_id).toBe(instanciaId);
    expect(r.retrabalho!.id).toBe(antes.id);
    expect(r.inspecao.retrabalhoInstanceId).toBe(antes.id);

    const n = ctx.sqlite
      .prepare(
        "SELECT count(*) AS n FROM task_instances WHERE template_id = ? AND status IN ('PENDING','IN_PROGRESS','OVERDUE')",
      )
      .get(templateId) as { n: number };
    expect(n.n).toBe(1); // índice único parcial intacto
  });

  it('MENOR (+2d) NÃO adia a aberta que já vence amanhã (min)', () => {
    // DIARIO: onComplete gera a próxima para amanhã
    const { instanciaId, templateId } = executada('= 1');
    const amanha = somarDias(dataRecife(new Date()), 1);
    const antes = abertaDo(templateId)!;
    expect(antes.due_date <= amanha).toBe(true);

    onInspect(
      ctx.db,
      instanciaId,
      { resultado: 'REPROVADA', motivo: 'PO_RESIDUAL', severidade: 'MENOR' },
      vist,
      new Date(),
    );
    const depois = abertaDo(templateId)!;
    expect(depois.due_date).toBe(antes.due_date); // min manteve a mais cedo
    expect(depois.rework_of_instance_id).toBe(instanciaId);
  });

  it('sem aberta (template sintético inativo p/ agendamento): cria o retrabalho vinculado', () => {
    // template SHIP_EVENT puro: onComplete não gera próxima → fila fica vazia
    const areaId = (ctx.sqlite.prepare('SELECT id FROM areas LIMIT 1').get() as { id: number }).id;
    const t = ctx.sqlite
      .prepare(
        `INSERT INTO task_templates (area_id, atividade, frequency, interval_days, schedule_mode,
           grace_days, trigger_type, ship_phase, ativo) VALUES (?, 'Sintética pós-navio', 'QUINZENAL',
           15, 'FLOATING', 1, 'SHIP_EVENT', 'POST_OPERATION', 1)`,
      )
      .run(areaId).lastInsertRowid as number;
    const i = ctx.sqlite
      .prepare(
        `INSERT INTO task_instances (template_id, due_date, window_end, status, origin, executante_id, finished_at)
         VALUES (?, ?, ?, 'DONE_ON_TIME', 'SHIP', ?, unixepoch())`,
      )
      .run(t, dataRecife(new Date()), dataRecife(new Date()), exec.id).lastInsertRowid as number;

    const r = onInspect(
      ctx.db,
      i,
      { resultado: 'REPROVADA', motivo: 'RESIDUO_VISIVEL', severidade: 'MAIOR' },
      vist,
      new Date(),
    );
    expect(r.retrabalho).not.toBeNull();
    expect(r.retrabalho!.dueDate).toBe(somarDias(dataRecife(new Date()), 1));
    const criada = abertaDo(t)!;
    expect(criada.rework_of_instance_id).toBe(i);
  });

  it('rollback íntegro: ator fantasma → nem inspeção, nem antecipação', () => {
    const { instanciaId, templateId } = executada('>= 7');
    const antes = abertaDo(templateId)!;

    expect(() =>
      onInspect(
        ctx.db,
        instanciaId,
        { resultado: 'REPROVADA', motivo: 'MOFO', severidade: 'CRITICA' },
        { id: 9999, login: 'fantasma' },
        new Date(),
      ),
    ).toThrow();

    expect(
      (ctx.sqlite.prepare('SELECT count(*) AS n FROM inspections').get() as { n: number }).n,
    ).toBe(0);
    const depois = abertaDo(templateId)!;
    expect(depois.due_date).toBe(antes.due_date);
    expect(depois.rework_of_instance_id).toBeNull();
  });
});

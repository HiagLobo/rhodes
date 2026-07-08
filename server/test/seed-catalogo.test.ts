import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDb, runMigrations } from '../src/db/index.js';
import { CHECKLIST_VALIDADO, seedCatalogo } from '../src/db/seed-catalogo.js';

function bancoSemeado() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-seed-cat-'));
  const { db, sqlite } = createDb(dir);
  runMigrations(db);
  seedCatalogo(db);
  return { db, sqlite };
}

describe('seed do catálogo — fidelidade ao checklist validado', () => {
  it('contagens exatas: 39 procedimentos, 34 áreas, frequências e gatilhos do xlsx', () => {
    const { sqlite } = bancoSemeado();
    expect(CHECKLIST_VALIDADO.length).toBe(39);

    const total = sqlite.prepare('SELECT COUNT(*) as n FROM task_templates').get() as { n: number };
    expect(total.n).toBe(39);

    const nAreas = sqlite.prepare('SELECT COUNT(*) as n FROM areas').get() as { n: number };
    expect(nAreas.n).toBe(34);

    const porFrequencia = Object.fromEntries(
      (
        sqlite
          .prepare('SELECT frequency, COUNT(*) as n FROM task_templates GROUP BY frequency')
          .all() as Array<{ frequency: string; n: number }>
      ).map((r) => [r.frequency, r.n]),
    );
    expect(porFrequencia).toEqual({
      DIARIO: 2,
      SEMANAL: 7,
      QUINZENAL: 15, // 7 puras + 8 híbridas pós-navio
      MENSAL: 5, // 4 puras + 1 híbrida (Túnel Recebimento)
      BIMESTRAL: 2,
      SEMESTRAL: 8,
    });

    const hibridas = sqlite
      .prepare(
        "SELECT COUNT(*) as n FROM task_templates WHERE trigger_type = 'HYBRID' AND ship_phase = 'POST_OPERATION' AND lead_days = 2",
      )
      .get() as { n: number };
    expect(hibridas.n).toBe(9);

    const fixed = sqlite
      .prepare("SELECT COUNT(*) as n FROM task_templates WHERE schedule_mode = 'FIXED'")
      .get() as { n: number };
    expect(fixed.n).toBe(9); // 2 diárias + 7 semanais
    sqlite.close();
  });

  it('DUPLICIDADES INTENCIONAIS do checklist — não são erro, não "consertar"', () => {
    const { sqlite } = bancoSemeado();
    const conta = (sql: string) => (sqlite.prepare(sql).get() as { n: number }).n;

    // A28 + A29: piso da MPL tem rotina diária E semanal
    expect(
      conta(
        "SELECT COUNT(*) as n FROM task_templates t JOIN areas a ON a.id = t.area_id WHERE a.nome = 'Prédio da Máquina de limpeza (piso)'",
      ),
    ).toBe(2);

    // A25 + A26: redlers de expedição têm limpeza semanal a seco E profilaxia mensal
    expect(
      conta(
        "SELECT COUNT(*) as n FROM task_templates t JOIN areas a ON a.id = t.area_id WHERE a.nome = 'Redlers de expedição'",
      ),
    ).toBe(2);

    // A37 + A38 + A43: subproduto tem 2 semanais (mesma atividade, métodos diferentes!) + 1 quinzenal
    expect(
      conta(
        "SELECT COUNT(*) as n FROM task_templates t JOIN areas a ON a.id = t.area_id WHERE a.nome = 'Área de expedição de subproduto'",
      ),
    ).toBe(3);
    expect(
      conta(
        "SELECT COUNT(*) as n FROM task_templates t JOIN areas a ON a.id = t.area_id WHERE a.nome = 'Área de expedição de subproduto' AND t.frequency = 'SEMANAL'",
      ),
    ).toBe(2);

    // A35 + A36: expedição de malte tem 2 rotinas quinzenais
    expect(
      conta(
        "SELECT COUNT(*) as n FROM task_templates t JOIN areas a ON a.id = t.area_id WHERE a.nome = 'Área expedição de malte'",
      ),
    ).toBe(2);
    sqlite.close();
  });

  it('idempotência 2× — mesmas contagens, nenhuma versão de método duplicada', () => {
    const { db, sqlite } = bancoSemeado();
    seedCatalogo(db);
    const t = sqlite.prepare('SELECT COUNT(*) as n FROM task_templates').get() as { n: number };
    const v = sqlite.prepare('SELECT COUNT(*) as n FROM metodo_versoes').get() as { n: number };
    const a = sqlite.prepare('SELECT COUNT(*) as n FROM areas').get() as { n: number };
    expect(t.n).toBe(39);
    expect(v.n).toBe(39);
    expect(a.n).toBe(34);
    sqlite.close();
  });

  it('todo procedimento tem método versão 1 apontado como atual', () => {
    const { sqlite } = bancoSemeado();
    const semPonteiro = sqlite
      .prepare('SELECT COUNT(*) as n FROM task_templates WHERE metodo_versao_atual_id IS NULL')
      .get() as { n: number };
    expect(semPonteiro.n).toBe(0);
    const versoesErradas = sqlite
      .prepare('SELECT COUNT(*) as n FROM metodo_versoes WHERE versao != 1')
      .get() as { n: number };
    expect(versoesErradas.n).toBe(0);
    sqlite.close();
  });

  it('interval/grace derivados da frequência (regra dos 10%)', () => {
    const { sqlite } = bancoSemeado();
    const quinzenal = sqlite
      .prepare(
        "SELECT interval_days, grace_days FROM task_templates WHERE frequency = 'QUINZENAL' LIMIT 1",
      )
      .get() as { interval_days: number; grace_days: number };
    expect(quinzenal).toEqual({ interval_days: 14, grace_days: 1 });
    const semestral = sqlite
      .prepare(
        "SELECT interval_days, grace_days FROM task_templates WHERE frequency = 'SEMESTRAL' LIMIT 1",
      )
      .get() as { interval_days: number; grace_days: number };
    expect(semestral).toEqual({ interval_days: 182, grace_days: 18 });
    sqlite.close();
  });

  it('pesos de criticidade por grupo (arquitetura §7)', () => {
    const { sqlite } = bancoSemeado();
    const peso = (nome: string) =>
      (sqlite.prepare('SELECT peso_criticidade as p FROM areas WHERE nome = ?').get(nome) as {
        p: number;
      }).p;
    expect(peso('Silo 01')).toBe(1.5);
    expect(peso('Prédio da Máquina de limpeza (piso)')).toBe(1.5);
    expect(peso('Prédio Máquina de Limpeza (Filtros de Manga)')).toBe(1.5);
    expect(peso('Silos de Pó')).toBe(1.5);
    expect(peso('Túnel Recebimento')).toBe(1.25);
    expect(peso('Moega de Recebimento (superior)')).toBe(1.25);
    expect(peso('Área externa - acesso ao terminal (portões)')).toBe(1.0);
    expect(peso('Máquina de Pré Limpeza')).toBe(1.0);
    sqlite.close();
  });

  it('limitações registradas nas 3 linhas que as têm no checklist', () => {
    const { sqlite } = bancoSemeado();
    const comLimitacao = sqlite
      .prepare(
        'SELECT a.nome FROM task_templates t JOIN areas a ON a.id = t.area_id WHERE t.limitacoes IS NOT NULL ORDER BY a.nome',
      )
      .all() as Array<{ nome: string }>;
    expect(comLimitacao.map((r) => r.nome)).toEqual([
      'Elevador de recebimento (1B)',
      'Prédio Máquina de Limpeza (Filtros de Manga)',
      'Prédio da Máquina de limpeza (paredes)',
    ]);
    sqlite.close();
  });
});

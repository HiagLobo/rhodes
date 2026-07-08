import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDb, runMigrations } from '../src/db/index.js';
import {
  ehAmostral,
  lerPctAmostral,
  PCT_AMOSTRAL_DEFAULT,
} from '../src/services/scheduler/amostragem.js';

describe('ehAmostral (sorteio determinístico)', () => {
  it('distribui ~N% em 10 000 ids (10% → 8..12%; 25% → 22..28%)', () => {
    for (const pct of [10, 25]) {
      let sorteados = 0;
      for (let id = 1; id <= 10_000; id++) if (ehAmostral(id, pct)) sorteados++;
      const obtido = sorteados / 100; // em %
      expect(obtido, `pct=${pct}`).toBeGreaterThan(pct - 3);
      expect(obtido, `pct=${pct}`).toBeLessThan(pct + 3);
    }
  });

  it('é determinístico e respeita os extremos', () => {
    for (let id = 1; id <= 50; id++) {
      expect(ehAmostral(id, 10)).toBe(ehAmostral(id, 10)); // mesma resposta sempre
      expect(ehAmostral(id, 0)).toBe(false);
      expect(ehAmostral(id, 100)).toBe(true);
    }
    // subir o pct nunca DES-sorteia quem já estava na amostra (h%100 < pct é monotônico)
    for (let id = 1; id <= 200; id++) {
      if (ehAmostral(id, 10)) expect(ehAmostral(id, 25)).toBe(true);
    }
  });
});

describe('lerPctAmostral (dado versionado)', () => {
  it('sem linha → default; última linha de score_config manda; JSON inválido → default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-amostra-'));
    const { db, sqlite } = createDb(dir);
    runMigrations(db);

    expect(lerPctAmostral(db)).toBe(PCT_AMOSTRAL_DEFAULT);

    sqlite
      .prepare("INSERT INTO score_config (valores, motivo) VALUES ('{\"vistoriaAmostralPct\":25}', 'teste')")
      .run();
    expect(lerPctAmostral(db)).toBe(25);

    sqlite.prepare("INSERT INTO score_config (valores, motivo) VALUES ('nao-e-json', 'teste')").run();
    expect(lerPctAmostral(db)).toBe(PCT_AMOSTRAL_DEFAULT); // fail-safe, nunca explode

    sqlite.close();
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/lib/env.js';

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rhodes-env-'));
}

describe('loadEnv', () => {
  it('recusa RHODES_DATA_DIR dentro de OneDrive (SQLite corrompe em pasta sincronizada)', () => {
    expect(() => loadEnv({ RHODES_DATA_DIR: 'C:\\Users\\fulano\\OneDrive\\dados' })).toThrow(
      /OneDrive/,
    );
  });

  it('recusa caminho relativo', () => {
    expect(() => loadEnv({ RHODES_DATA_DIR: 'dados-relativos' })).toThrow(/absoluto/);
  });

  it('aceita diretório temporário e cria logs/', () => {
    const dir = tmpDataDir();
    const env = loadEnv({ RHODES_DATA_DIR: dir });
    expect(env.RHODES_DATA_DIR).toBe(path.resolve(dir));
    expect(fs.existsSync(path.join(dir, 'logs'))).toBe(true);
  });

  it('defaults: development, porta 3000, host 0.0.0.0', () => {
    const env = loadEnv({ RHODES_DATA_DIR: tmpDataDir() });
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe('0.0.0.0');
  });

  it('produção faz bind só em localhost — o Caddy é a única entrada da rede', () => {
    const env = loadEnv({ NODE_ENV: 'production', RHODES_DATA_DIR: tmpDataDir() });
    expect(env.HOST).toBe('127.0.0.1');
  });
});

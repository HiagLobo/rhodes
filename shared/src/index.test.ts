import { describe, expect, it } from 'vitest';

import { APP_NAME, TIMEZONE } from './index.js';

describe('shared — smoke', () => {
  it('exporta o nome do sistema', () => {
    expect(APP_NAME).toContain('Rhodes');
  });

  it('fuso do projeto é fixo em America/Recife (sem DST)', () => {
    expect(TIMEZONE).toBe('America/Recife');
  });
});

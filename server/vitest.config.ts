import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // O 1º teste de cada arquivo paga o novoApp() inteiro (11+ migrações + argon2 do
    // seed) — sob I/O carregado isso passa dos 5s default e falhava em lote (Onda 06).
    testTimeout: 30_000,
  },
  resolve: {
    // Testes resolvem o shared pela FONTE (o exports do pacote aponta para dist,
    // que só existe após build — necessário apenas para o node em produção).
    alias: {
      '@rhodes/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
});

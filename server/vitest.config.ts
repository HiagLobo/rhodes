import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Testes resolvem o shared pela FONTE (o exports do pacote aponta para dist,
    // que só existe após build — necessário apenas para o node em produção).
    alias: {
      '@rhodes/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
});

import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // O web sempre consome o shared pela FONTE (HMR + sem depender de shared/dist);
    // o exports do pacote (→ dist) existe para o runtime node do server.
    alias: {
      '@rhodes/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    // Em dev o Vite serve o front e repassa a API para o Fastify (porta 3000).
    proxy: { '/api': 'http://localhost:3000' },
  },
});

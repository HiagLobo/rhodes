import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Em dev o Vite serve o front e repassa a API para o Fastify (porta 3000).
    proxy: { '/api': 'http://localhost:3000' },
  },
});

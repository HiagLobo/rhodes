import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA, type VitePWAOptions } from 'vite-plugin-pwa';

/**
 * PWA (Onda 10/S1) — o app instala na tela inicial e ABRE sem sinal (o shell vem do precache).
 *
 * Duas regras inegociáveis, exportadas aqui para o teste poder cobrá-las:
 * 1. O service worker NUNCA cacheia `/api/*` — evidência e PII não podem ser servidas de cache, e
 *    leitura velha não pode virar verdade (ALCOA+ "Contemporâneo"). Sem `runtimeCaching`, e o
 *    fallback de navegação da SPA ignora `/api`.
 * 2. `registerType: 'prompt'` — o SW nunca recarrega a página sozinho: recarregar no meio de uma
 *    execução (com o cronômetro rodando e fotos na tela) perderia o estado do executante.
 */
export const pwaOptions: Partial<VitePWAOptions> = {
  registerType: 'prompt',
  includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],
  manifest: {
    name: 'Sistema de Gestão de Limpeza — Rhodes S.A',
    short_name: 'Rhodes · Limpeza',
    description: 'Plano de limpeza, evidência fotográfica e vistoria do terminal.',
    lang: 'pt-BR',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    theme_color: '#1971c2', // primaryColor blue, shade 8 (theme.ts)
    background_color: '#ffffff',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  },
  workbox: {
    // Só o shell estático entra no precache.
    globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,webmanifest}'],
    // O fallback da SPA não pode engolir a API (ela precisa responder 404/401 JSON de verdade).
    navigateFallback: '/index.html',
    navigateFallbackDenylist: [/^\/api\//],
    // SEM runtimeCaching: nenhuma resposta de /api/* é cacheada. Ver regra 1 acima.
    cleanupOutdatedCaches: true,
  },
  devOptions: { enabled: false }, // SW só no build — não atrapalha o HMR
};

export default defineConfig({
  plugins: [react(), VitePWA(pwaOptions)],
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

import { describe, expect, it } from 'vitest';

import { pwaOptions } from '../vite.config';

/**
 * O PWA é configuração, e configuração errada aqui é silenciosa e perigosa: um `runtimeCaching` em
 * `/api/*` serviria evidência de cache (ALCOA+ "Contemporâneo") e um `registerType: 'autoUpdate'`
 * recarregaria a página no meio de uma execução. Este teste cobra as duas regras na FONTE.
 */
describe('configuração do PWA', () => {
  it('nunca recarrega sozinho (registerType = prompt)', () => {
    expect(pwaOptions.registerType).toBe('prompt');
  });

  it('NÃO cacheia /api/* — sem runtimeCaching e com o fallback da SPA negando /api', () => {
    const wb = pwaOptions.workbox!;
    // nenhuma regra de cache em tempo de execução (é o que cachearia respostas da API)
    expect(wb.runtimeCaching).toBeUndefined();
    // o fallback de navegação não pode engolir a API (ela responde 404/401 JSON de verdade)
    expect(wb.navigateFallbackDenylist?.some((re) => re.test('/api/instancias/1'))).toBe(true);
    expect(wb.navigateFallbackDenylist?.some((re) => re.test('/agora'))).toBe(false);
    // o precache leva só o shell estático — nada de JSON nem de fotos
    const glob = wb.globPatterns!.join(' ');
    expect(glob).not.toContain('json');
    expect(glob).not.toContain('jpg');
  });

  it('manifest instalável: standalone, start_url, PT-BR e ícones 192/512 (um maskable)', () => {
    const m = pwaOptions.manifest as Record<string, unknown> & {
      icons: { sizes: string; purpose?: string }[];
    };
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');
    expect(m.lang).toBe('pt-BR');
    expect(m.theme_color).toBe('#1971c2'); // primaryColor blue shade 8 (theme.ts)

    const tamanhos = m.icons.map((i) => i.sizes);
    expect(tamanhos).toContain('192x192');
    expect(tamanhos).toContain('512x512');
    expect(m.icons.some((i) => i.purpose?.includes('maskable'))).toBe(true);
  });

  it('o service worker não é registrado em dev (não atrapalha o HMR)', () => {
    expect(pwaOptions.devOptions?.enabled).toBe(false);
  });
});

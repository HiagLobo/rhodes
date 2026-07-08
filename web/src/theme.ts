import { Button, createTheme, type CSSVariablesResolver } from '@mantine/core';

/**
 * Bandas de comunicação do score (modelo SQF — arquitetura §7):
 * ≥96 Excelente · 86–95 Bom · 70–85 Atenção · <70 Crítico.
 * São as cores oficiais de status do sistema inteiro (dashboard, heatmap, TV andon).
 */
export const BANDAS = {
  excelente: '#146c2e',
  bom: '#2f9e44',
  atencao: '#e8590c',
  critico: '#c92a2a',
} as const;

/** Lei visual do app de campo: alvo de toque operável com luvas (arquitetura §5). */
export const ALTURA_MINIMA_BOTAO = 56;

/**
 * Tema industrial de alto contraste: fontes com peso, texto escuro sobre claro
 * (nunca cinza sobre branco — legibilidade sob sol forte no cais).
 */
export const theme = createTheme({
  primaryColor: 'blue',
  primaryShade: 8,
  fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
  headings: { fontWeight: '800' },
  components: {
    Button: Button.extend({
      defaultProps: { size: 'lg' },
      styles: { root: { minHeight: ALTURA_MINIMA_BOTAO, fontWeight: 700 } },
    }),
  },
});

/** Expõe as bandas como CSS vars para uso em qualquer célula/estilo (--banda-*). */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {
    '--banda-excelente': BANDAS.excelente,
    '--banda-bom': BANDAS.bom,
    '--banda-atencao': BANDAS.atencao,
    '--banda-critico': BANDAS.critico,
  },
  light: {},
  dark: {},
});

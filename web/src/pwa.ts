import { registerSW } from 'virtual:pwa-register';

/**
 * Registro do service worker (Onda 10/S1).
 *
 * `registerType: 'prompt'` (vite.config.ts): o SW NUNCA recarrega a página sozinho. Recarregar no
 * meio de uma execução — cronômetro rodando, fotos na tela — perderia o estado do executante. Quando
 * há versão nova, mostramos um aviso e o usuário decide QUANDO atualizar.
 *
 * O aviso é um banner mínimo em DOM puro de propósito: esta sub não toca o `App.tsx`. A S3 (que já
 * mexe no Shell para o indicador de sync) pode trocá-lo por um componente Mantine.
 */

let aplicar: ((recarregar?: boolean) => Promise<void>) | null = null;

/** Aplica a versão nova e recarrega. Só é chamado por ação EXPLÍCITA do usuário. */
export async function aplicarAtualizacao(): Promise<void> {
  await aplicar?.(true);
}

function mostrarBannerAtualizacao(): void {
  if (document.getElementById('pwa-atualizar')) return;

  const barra = document.createElement('div');
  barra.id = 'pwa-atualizar';
  barra.setAttribute('role', 'status');
  Object.assign(barra.style, {
    position: 'fixed',
    insetInline: '0',
    bottom: '0',
    zIndex: '9999',
    display: 'flex',
    gap: '12px',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '12px',
    background: '#1971c2',
    color: '#fff',
    font: "600 15px 'Segoe UI', system-ui, sans-serif",
  });

  const texto = document.createElement('span');
  texto.textContent = 'Nova versão disponível.';

  const botao = document.createElement('button');
  botao.type = 'button';
  botao.textContent = 'Atualizar';
  Object.assign(botao.style, {
    minHeight: '44px',
    padding: '0 16px',
    border: '0',
    borderRadius: '6px',
    background: '#fff',
    color: '#1971c2',
    font: "700 15px 'Segoe UI', system-ui, sans-serif",
    cursor: 'pointer',
  });
  botao.addEventListener('click', () => {
    botao.disabled = true;
    void aplicarAtualizacao();
  });

  const depois = document.createElement('button');
  depois.type = 'button';
  depois.textContent = 'Depois';
  Object.assign(depois.style, {
    minHeight: '44px',
    padding: '0 12px',
    border: '1px solid rgba(255,255,255,.6)',
    borderRadius: '6px',
    background: 'transparent',
    color: '#fff',
    font: "600 15px 'Segoe UI', system-ui, sans-serif",
    cursor: 'pointer',
  });
  depois.addEventListener('click', () => barra.remove());

  barra.append(texto, botao, depois);
  document.body.appendChild(barra);
}

/** Registra o SW. Sem suporte a service worker (ou em teste), não faz nada. */
export function registrarPwa(): void {
  if (!('serviceWorker' in navigator)) return;
  aplicar = registerSW({
    immediate: true,
    onNeedRefresh: mostrarBannerAtualizacao,
  });
}

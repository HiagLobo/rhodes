import '@mantine/core/styles.css';

import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App';
import { registrarPwa } from './pwa';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// PWA (Onda 10/S1): precache do shell para o app abrir sem sinal. Nunca recarrega sozinho.
registrarPwa();

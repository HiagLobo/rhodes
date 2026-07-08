# rhodes-app — Sistema de Gestão de Limpeza (Rhodes S.A / Porto do Recife)

Plano mestre de limpeza digital do terminal de grãos: 39 procedimentos com agendamento híbrido
(calendário + evento de navio), execução com foto antes/depois, vistoria e score 0–100.
A arquitetura completa vive em `PESQUISA E ARQUITETURA - Sistema de Gestão de Limpeza.md`
(raiz do workspace, fora deste repo) e o plano de execução em `waves/`.

## Stack

- `server/` — Fastify + TypeScript, SQLite (WAL) via better-sqlite3 + Drizzle (chega na S2)
- `web/` — React + Vite + Mantine, PWA (chega na S3)
- `shared/` — contratos Zod e enums de domínio compartilhados

## Pré-requisitos

- Node 24 LTS (ver `.nvmrc` — better-sqlite3 é módulo nativo, compilado contra esta versão)
- npm 11+

## Comandos

```bash
npm install        # instala os 3 workspaces
npm run dev        # server (tsx watch, :3000) + web (vite, :5173 com proxy /api) em paralelo
npm run lint       # eslint em todo o repo
npm run typecheck  # tsc --noEmit por workspace
npm test           # vitest por workspace
npm run build      # build por workspace (web → web/dist)
```

Em produção (`NODE_ENV=production`) o próprio Fastify serve `web/dist` com fallback SPA —
um único processo entrega front e API; o Vite só existe em desenvolvimento.

## Variáveis de ambiente (server)

| Variável | Default | Descrição |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` faz bind só em `127.0.0.1` (Caddy é a entrada) |
| `PORT` | `3000` | porta do Fastify |
| `RHODES_DATA_DIR` | `C:\rhodes-data` | banco, fotos e logs — caminho absoluto, **recusa OneDrive** |

O boot é fail-fast: env inválido derruba o processo com mensagem explicativa. As migrações
(Drizzle, sempre aditivas) rodam automaticamente na subida, antes de aceitar conexões.

## Regras que não se negociam

- **Dados NUNCA neste repo nem em pasta OneDrive**: banco SQLite e fotos vivem em
  `RHODES_DATA_DIR` (default `C:\rhodes-data\`) — SQLite corrompe em pasta sincronizada.
- Timestamps de negócio são sempre do servidor; trilha de auditoria é append-only (ALCOA+).
- Ver skill `rhodes-executar-onda` para o padrão de execução (1 sessão = 1 Sx = 1 commit).

## Deploy

Runbook completo em [deploy/README-DEPLOY.md](deploy/README-DEPLOY.md) — subida do zero numa
máquina Windows: `deploy.ps1` (build + publicação em `C:\rhodes\app`), serviços `rhodes-app` e
`rhodes-caddy` via WinSW, HTTPS interno do Caddy e instalação da CA nos aparelhos.

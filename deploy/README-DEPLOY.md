# Runbook de deploy — Sistema Rhodes (servidor Windows na LAN)

Este documento sobe o sistema numa máquina Windows **do zero**, sem conhecimento prévio.
Guarde uma cópia impressa junto ao servidor (mitigação de bus factor).

## Visão

```text
celulares/desktops da LAN ──HTTPS──▶ Caddy (serviço rhodes-caddy, porta 443)
                                        │ proxy
                                        ▼
                              app Fastify (serviço rhodes-app, 127.0.0.1:3000)
                                        │
                              C:\rhodes-data\  (banco SQLite + fotos + logs)
```

| Pasta | Conteúdo |
| --- | --- |
| `C:\rhodes\app` | build publicado (server/dist, web/dist, node_modules de produção) |
| `C:\rhodes\caddy` | caddy.exe, Caddyfile e a CA interna (`data\caddy\pki\...`) |
| `C:\rhodes\winsw` | WinSW + xmls dos 2 serviços |
| `C:\rhodes-data` | **dados** — banco, fotos, logs. NUNCA em OneDrive. Backup na Onda 12 |

## 1. Pré-requisitos (uma vez por máquina)

1. **Node.js 24 LTS** (instalador Windows x64, opção "para todos os usuários"):
   <https://nodejs.org/en/download> — confira com `node --version` → `v24.x`.
2. **Caddy** (binário oficial x64): <https://caddyserver.com/api/download?os=windows&arch=amd64>
   → salvar como `C:\rhodes\caddy\caddy.exe`.
3. **WinSW v2.12.0** (x64): <https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe>
   → salvar como `C:\rhodes\winsw\WinSW-x64.exe`.
4. Código do sistema (repo `rhodes-app/`) na máquina, com `npm install` executado.

## 2. Publicar (a cada versão)

> Com os serviços já instalados, rode em PowerShell **como administrador** (parar/religar
> serviço exige elevação — o script confere isso antes do build e avisa).

```powershell
powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1
```

O script: valida Node 24 → builda web+server → para os serviços → espelha os builds em
`C:\rhodes\app` → `npm ci --omit=dev` no destino → copia Caddyfile/xmls → religa os serviços →
confere o `/api/health`. Janela de indisponibilidade ≈30s. Pode rodar quantas vezes quiser.

## 3. Instalar os serviços (uma vez, PowerShell **como administrador**)

```powershell
C:\rhodes\winsw\rhodes-app.exe install
C:\rhodes\winsw\rhodes-caddy.exe install
Start-Service rhodes-app, rhodes-caddy
Get-Service rhodes-app, rhodes-caddy   # ambos "Running"
```

> Se `node` não estiver no PATH do sistema, edite `C:\rhodes\winsw\rhodes-app.xml` e troque
> `<executable>node</executable>` por `C:\Program Files\nodejs\node.exe`, depois
> `rhodes-app.exe refresh`.

## 4. Nome na rede (`rhodes.local`)

Os aparelhos precisam resolver `rhodes.local` para o IP do servidor. Escolha UMA opção:

- **Roteador (recomendado):** criar reserva de IP para o servidor + entrada DNS local
  `rhodes.local` → IP do servidor; ou
- **Arquivo hosts** em cada desktop (como admin):
  `Add-Content C:\Windows\System32\drivers\etc\hosts "192.168.x.x  rhodes.local"`
  (celulares Android não têm hosts editável — use a opção do roteador para o campo).

## 5. Instalar a CA interna nos aparelhos (uma vez por aparelho)

O certificado raiz fica em `C:\rhodes\caddy\data\caddy\pki\authorities\local\root.crt`
(existe após a primeira subida do rhodes-caddy).

- **Windows (desktop):** botão direito em `root.crt` → Instalar certificado → Máquina local →
  "Autoridades de Certificação Raiz Confiáveis".
- **Android (celulares de campo):** copiar `root.crt` para o aparelho → Configurações →
  Segurança → Criptografia e credenciais → Instalar certificado → **Certificado de CA** →
  aceitar o aviso. Depois abrir `https://rhodes.local` no Chrome — cadeado sem erro.
- **iOS (evitar para o campo — decisão de arquitetura):** além de instalar o perfil, é preciso
  ativar em Ajustes → Geral → Sobre → Configurações de Confiança de Certificado ("Full Trust").

⚠️ Nunca oriente ninguém a "aceitar certificado inválido" — se o cadeado reclamar, a CA não está
instalada direito.

## 6. Teste de aceitação da instalação

1. `https://rhodes.local/api/health` no navegador do próprio servidor → `{"status":"ok",...}`.
2. O mesmo endereço num **segundo dispositivo** da LAN (com CA instalada) → sem aviso de
   certificado.
3. `http://rhodes.local` → redireciona sozinho para `https://`.
4. **Reiniciar a máquina** → os dois serviços voltam sozinhos (`Get-Service rhodes-app,
   rhodes-caddy`) e o health responde.

## 7. Problemas comuns

| Sintoma | Causa provável / ação |
| --- | --- |
| `rhodes-app` não inicia | ver `C:\rhodes\winsw\rhodes-app.out.log` e `.err.log`; PATH do node (ver §3) |
| health 503 | banco indisponível — ver `C:\rhodes-data\logs\app.*.log` |
| porta 443 ocupada | `Get-NetTCPConnection -LocalPort 443 -State Listen` e desativar o conflitante |
| cadeado com erro no aparelho | CA não instalada (Android: precisa ser como "Certificado de CA") |
| deploy falha no `npm ci` | máquina sem internet — better-sqlite3 precisa baixar o prebuild |

## 8. Servidor pronto para produção (resumo — checklist completo na Onda 12)

- Relógio certo: `w32tm /resync` (toda a evidência depende do relógio do servidor).
- Firewall: liberar só 443 (e 80 para o redirect) na rede privada.
- ⚠️ Windows 10 está sem suporte desde 14/10/2025 — produção deve rodar em Windows 11 Pro/Server.
- UPS no servidor; Windows Update com reinício agendado fora do turno.

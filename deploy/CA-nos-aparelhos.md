# Instalar a CA interna nos aparelhos (pré-requisito do PWA)

> Sem isto o Android **não oferece instalar o app** e o service worker **não registra**. Não é
> frescura de navegador: PWA só funciona em origem segura, e `https://rhodes.local` usa um
> certificado emitido pela CA interna do Caddy — que o aparelho ainda não conhece.

Vale para todo celular/tablet que for usar o app no pátio. Leva ~3 minutos por aparelho.

## 1. Exportar o certificado da CA (uma vez, no servidor)

O Caddy cria a própria CA na primeira subida. O certificado **raiz** fica em:

```
C:\Users\<usuario-do-servico>\AppData\Roaming\Caddy\pki\authorities\local\root.crt
```

> Se o Caddy roda como serviço (WinSW), o `<usuario-do-servico>` é a conta do serviço, não a sua.
> Confirme o caminho no log do Caddy na primeira subida ("certificate authority ... root.crt").

Copie o `root.crt` para uma pasta compartilhada da LAN e renomeie para algo reconhecível, ex.:
`rhodes-ca.crt`. **Só o `root.crt`** — nunca copie o `root.key` (a chave privada da CA).

## 2. Levar o arquivo até o aparelho

Qualquer um destes: pendrive/USB, compartilhamento da LAN, ou baixar de um endereço interno.
**Não** mande por WhatsApp/e-mail externo — o certificado não é segredo, mas a rota é.

## 3. Instalar como *Certificado de CA* (o passo que as pessoas erram)

No Android (o menu muda um pouco por fabricante/versão):

1. **Configurações → Segurança e privacidade → Mais segurança → Criptografia e credenciais**
   (em alguns aparelhos: *Segurança → Credenciais*).
2. **Instalar um certificado** → escolha **Certificado de CA** *(NÃO "Certificado VPN e app")*.
3. Um aviso vermelho aparece ("sua rede pode ser monitorada") → **Instalar mesmo assim**.
4. Selecione o `rhodes-ca.crt`.
5. Se o aparelho pedir, defina bloqueio de tela (PIN/senha) — o Android exige para guardar CAs.

> **Erro clássico:** instalar em *"Certificado VPN e app"*. O arquivo entra, o Android diz "instalado"
> e **o navegador continua desconfiando**. Tem que ser **Certificado de CA**.

## 4. Conferir

1. Abra o Chrome e vá a `https://rhodes.local`.
2. Tem que carregar **sem aviso** e com o cadeado fechado. Se aparecer "conexão não é particular",
   a CA não foi instalada (ou foi no lugar errado — volte ao passo 3).

## 5. Instalar o app

1. Ainda no Chrome, em `https://rhodes.local`, abra o **menu (⋮)**.
2. **Instalar aplicativo** (ou *Adicionar à tela inicial* → "Instalar").
3. O ícone azul com o ✓ aparece na tela inicial. Abra por ele: o app roda em tela cheia, sem a barra
   do navegador.

## Sintomas e o que significam

| Sintoma | Causa provável |
|---|---|
| O menu **não oferece** "Instalar aplicativo" | A CA não está instalada (origem não é segura) ou o aparelho já tem o app instalado |
| "Sua conexão não é particular" em `rhodes.local` | Certificado instalado no lugar errado (VPN e app) ou não instalado |
| Instala, mas **não abre sem sinal** | O app precisa ser aberto **uma vez com rede** para o service worker precachear o shell |
| `rhodes.local` não resolve | DNS/hosts da LAN — problema de rede, não de certificado |

## Notas

- Instalar a CA **não** dá acesso a nada: só faz o aparelho confiar nos certificados que o servidor da
  Rhodes emite para si mesmo, dentro da LAN.
- Ao trocar o aparelho, repita o processo. Ao **reinstalar o Caddy do zero**, a CA muda — todos os
  aparelhos precisam do novo `root.crt`.
- iOS exige um passo extra (**Ajustes → Geral → Sobre → Confiança em certificado raiz**) e a fila
  offline tem limites diferentes (ITP). O alvo da Onda 10 é **Android**.

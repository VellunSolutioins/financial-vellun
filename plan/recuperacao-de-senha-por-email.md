# Plano — Recuperação de senha por e-mail

> **Status (2026-10-21): implementado** na branch `feat/recover-password`, do zero e seguindo
> este plano com o lembrete de 2026-10-10 aplicado. Diferenças em relação ao texto abaixo:
>
> - **Sem dependência nova:** o Resend é chamado pela API HTTP com `fetch` (Node 22), sem o SDK;
>   `@nestjs/throttler` já estava instalado e o guard é global (`AppThrottlerGuard`, por IP para
>   quem não está logado). Limites: `forgot-password` 5/15 min, `reset-password` 10/15 min.
> - **Serviço próprio:** a lógica fica em `auth/password-reset.service.ts` (não no
>   `AuthService`). O pedido responde na hora e processa em segundo plano, para o tempo de
>   resposta não revelar quais e-mails têm conta; no máximo um e-mail por minuto por conta.
> - **Sessões:** a redefinição chama `SessionService.revokeAllForUser` (todas as sessões).
> - **Trilha:** `password_reset_requested` e `password_reset` em `SecurityEventsService`.
> - **Token:** consumido de forma atômica (`updateMany` com `usedAt: null`), então dois envios do
>   mesmo link não trocam a senha duas vezes; erro com `errors: [{ field: 'token' }]`.
> - **`MAIL_PROVIDER=log` em produção** não escreve o link no log (só um aviso).
> - **Web:** telas em `components/auth/` (`forgot-password-form.tsx`,
>   `reset-password-form.tsx`); `/redefinir-senha` com `referrer: no-referrer` e `noindex`.
>   `middleware.ts` não precisou mudar (é no-op).
> - Existe uma implementação anterior do Bruno (`origin/feat/implements-password-recovery`,
>   2026-07-27) que não foi aproveitada: ficou 160 commits atrás da `main`.

> **Revisão do PR #36 (2026-10-21), ajustes aplicados:**
>
> - Trocar a senha (logado) ou o e-mail apaga os links de redefinição pendentes da conta.
> - A redefinição consome o link, troca a senha e revoga as sessões numa só transação
>   (`SessionService.revokeAllForUser` aceita o cliente da transação).
> - O intervalo de 1 e-mail/min por conta usa `pg_advisory_xact_lock` por usuário, com a
>   checagem dentro da transação: pedidos simultâneos não passam juntos.
> - Em produção, `MAIL_PROVIDER` ausente derruba a subida; `log` só se escrito de propósito.
> - O link usado é apagado na redefinição (a coluna `used_at` saiu) e um job diário às 4h
>   apaga os vencidos.
> - Validade e intervalo vêm na resposta de `POST /auth/forgot-password`
>   (`expiresInMinutes`, `retryAfterSeconds`) em vez de ficarem em `@financial-vellun/shared`:
>   a API só importa tipos desse pacote, que publica TypeScript sem build, e uma constante
>   importada em tempo de execução quebraria o `nest build`. O "peça de novo" espera o
>   intervalo com contagem regressiva.
> - `common/web-url.util.ts` centraliza a leitura de `WEB_URL` (auth, billing e ops).

## Contexto

O app permite trocar a senha logado (com a senha atual), mas quem esqueceu a senha não tem saída:
o login não tem "Esqueci minha senha" e não existe envio de e-mail no projeto.

Fluxo: o usuário informa o e-mail, recebe um link de uso único e curta duração e define a nova
senha.

```
/login → "Esqueci minha senha" → /esqueci-senha
  POST /auth/forgot-password { email }        resposta sempre genérica
    → se a conta existir e estiver dentro do limite: cria o token (só o hash é guardado)
      e envia ${WEB_URL}/redefinir-senha#token=<256 bits>
/redefinir-senha#token=…                      nova senha + confirmar
  POST /auth/reset-password { token, newPassword }
    → troca a senha, encerra todas as sessões, registra na trilha, envia o aviso por e-mail
```

### Por que não WhatsApp

- O bot não inicia conversa: a Meta só entrega texto livre nas 24 h seguintes a uma mensagem do
  usuário. Enviar um código exigiria template de autenticação, aprovado e cobrado.
- O número já lança dados na conta. Usá-lo também para recuperar a senha deixa um único fator
  controlando tudo.
- Número é reciclado pela operadora, e clonagem de WhatsApp e troca de chip são golpes comuns.
- Num incidente, fica difícil sustentar que a medida era "apta" (LGPD, arts. 46 e 44).

## Regras de segurança

| Regra                  | Detalhe                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| Resposta genérica      | `forgot-password` responde igual para conta existente, inexistente ou acima do limite.              |
| Envio fora da resposta | O e-mail é disparado sem `await`: o tempo da resposta não revela se a conta existe.                 |
| Token                  | `randomToken()` (256 bits), guardado só como `sha256Hex`, uso único, validade de 30 min.            |
| Um link por vez        | Pedir de novo expira os links abertos. Eles não são apagados: contam para o limite.                 |
| Limite por conta       | 3 pedidos por hora, contados na tabela. Linhas com mais de 24 h são apagadas.                       |
| Limite por IP          | `@Throttle({ default: { limit: 5, ttl: 60_000 } })` nas duas rotas.                                 |
| Consumo atômico        | `updateMany` condicional (`usedAt: null`, `expiresAt > now`); de dois envios simultâneos, um perde. |
| Token no fragmento     | `#token=` não chega a log de servidor nem a `Referer`; a tela o remove da barra ao ler.             |
| Sessões                | `SessionService.revokeAllForUser(userId)` e `clearAuthCookies` ao concluir.                         |
| Trilha                 | `password_reset_requested` e `password_reset_completed` em `SecurityEventsService`.                 |
| Aviso                  | E-mail "sua senha foi alterada" ao concluir, e também na troca logada.                              |
| Sem rastreamento       | Rastreamento de clique e de abertura desligado no provedor: ele reescreve o link e expõe o token.   |
| Log sem dado pessoal   | Destinatário sempre com `maskEmail`. O link nunca vai para o log fora do transport `log`.           |

## Mudanças

### API (`apps/api`)

**1. Prisma** — [schema.prisma](apps/api/prisma/schema.prisma)

- Model `PasswordResetToken { id, userId, tokenHash @unique, expiresAt, usedAt?, createdAt }`,
  com `onDelete: Cascade`, `@@index([userId, createdAt])` e `@@map("password_reset_tokens")`.
  Relação `passwordResetTokens` em `User`.
- Acrescentar os dois tipos novos ao comentário de `UserSecurityEvent`.
- `prisma migrate dev --name add_password_reset_token`.

**2. Módulo de e-mail** — `src/mail/`

Partir dos arquivos da branch `feat/implements-password-recovery` (commit `a2401dc`):
`mail.module.ts`, `mail.service.ts` e `transports/` (`log`, `resend`, interface). Ajustes:

- **Produção sem provedor derruba o boot.** Hoje a branch cai em silêncio para o transport `log`,
  e ninguém receberia e-mail. Seguir o padrão de `WHATSAPP_BOT_NUMBER` em
  [whatsapp-link.service.ts](apps/api/src/whatsapp-link/whatsapp-link.service.ts): com
  `NODE_ENV=production`, exigir `MAIL_PROVIDER=resend`, `RESEND_API_KEY` e `MAIL_FROM`.
- **Log com `maskEmail`** (de `security-events.service.ts`) no lugar do endereço em claro.
- **`sendPasswordChanged(to, name)`**, além de `sendPasswordReset(to, name, resetUrl)`.
- Texto do e-mail com validade de 30 minutos. Manter versão `text` e `html`, e `escapeHtml` no
  nome.
- Contador de falha de envio em
  [metrics.service.ts](apps/api/src/observability/metrics.service.ts): envio é _best-effort_, e
  sem métrica uma falha do provedor fica invisível.
- Dependência nova: `resend`. `.env.example`: `MAIL_PROVIDER=log`, `RESEND_API_KEY=`, `MAIL_FROM=`.

**3. Módulo `src/password-reset/`** (`*.module.ts`, `*.controller.ts`, `*.service.ts`, `dto/`)

- `request(email, context)`: busca sem diferenciar maiúsculas, como `findUserByEmail` em
  [auth.service.ts](apps/api/src/auth/auth.service.ts). Sem conta ou acima do limite, não faz
  nada. Caso contrário, numa transação: apaga linhas com mais de 24 h, expira os links abertos,
  cria o novo. Registra `password_reset_requested` e dispara o e-mail sem aguardar.
- `complete(token, newPassword, context)`: busca pelo hash; inexistente, usado ou expirado →
  `BadRequestException('Link inválido ou expirado. Peça um novo.')`. Consome com `updateMany`
  condicional e grava `bcrypt.hash(…, 12)` na mesma transação. Depois: `revokeAllForUser`,
  `password_reset_completed` e `sendPasswordChanged`.
- Controller em `auth`: `POST /auth/forgot-password` e `POST /auth/reset-password`, públicas, com
  `@HttpCode(200)` e `@Throttle`. `reset-password` chama `sessions.clearAuthCookies(res)`.
- DTOs: `ForgotPasswordDto { @IsEmail email }` e
  `ResetPasswordDto { @IsString @MaxLength(128) token, @MinLength(8) newPassword }`, com
  `@ApiProperty`.
- `PasswordResetModule` importa `AuthModule` (pelo `SessionService`) e `MailModule`; entra no
  [app.module.ts](apps/api/src/app.module.ts).
- `SecurityEventType` ganha `password_reset_requested` e `password_reset_completed`.
- O `CsrfGuard` não muda: sem cookie de sessão a requisição passa, e com cookie antigo vale a
  origem permitida.

**4. Troca logada** — [users.service.ts](apps/api/src/users/users.service.ts): `updatePassword`
passa a chamar `sendPasswordChanged`.

### Web (`apps/web`) — mobile first

- `app/(auth)/esqueci-senha/page.tsx` + `components/auth/forgot-password-form.tsx`: campo de
  e-mail (Zod, `onBlur: () => void trigger('email')`). Depois do envio, troca o formulário por um
  aviso: "Se houver uma conta com esse e-mail, enviamos o link. Ele vale por 30 minutos; confira
  também a caixa de spam."
- `app/(auth)/redefinir-senha/page.tsx` + `components/auth/reset-password-form.tsx`: lê o token
  de `window.location.hash` uma única vez (o StrictMode monta duas) e o remove com
  `history.replaceState`. Nova senha e confirmar com `PasswordInput`; Zod mínimo 8 e coincidência.
  Sucesso → toast e `/login`. Sem token, ou link recusado pela API → tela "Link inválido ou
  expirado" com botão para `/esqueci-senha`. `robots: noindex` na página.
- [login-form.tsx](apps/web/src/components/auth/login-form.tsx): link "Esqueci minha senha".
- [lib/auth.ts](apps/web/src/lib/auth.ts): `forgotPassword(email)` e
  `resetPassword({ token, newPassword })`.
- Reuso: `FormField`, `FormAlert` e `apiErrorMessages` de `components/auth/`, e o layout de
  `app/(auth)/`. O `middleware.ts` é no-op e o `api-client` só tenta refresh em 401: nenhum dos
  dois muda.

### Privacidade (LGPD)

- [privacidade/page.tsx](apps/web/src/app/privacidade/page.tsx): incluir o serviço de envio de
  e-mails entre os prestadores do parágrafo de compartilhamento e atualizar a data.
- Pendências que dependem do Bruno, anteriores a este plano: a política não cita transferência
  internacional de dados e aponta para "canais oficiais de atendimento" sem publicar nenhum.

### Documentação

[README.md](README.md) (variáveis `MAIL_*`), [infra/railway/README.md](infra/railway/README.md)
(variáveis no serviço da API) e [CLAUDE.md](CLAUDE.md) (`mail/`, `password-reset/` e as duas
rotas novas em `app/(auth)/`).

## Pré-requisitos fora do código

1. Conta no Resend e domínio de envio verificado (SPF e DKIM), com DMARC publicado.
2. Rastreamento de clique e de abertura desligado no domínio.
3. Chave de API restrita a envio, em `RESEND_API_KEY` no serviço da API.
4. `MAIL_FROM` com remetente do domínio verificado, por exemplo
   `Financial Vellun <nao-responda@dominio>`.

## Fora de escopo

- **Verificar o e-mail no cadastro.** Hoje o e-mail nunca é confirmado; quem digitou errado não
  recupera a conta. É o próximo passo natural, e reaproveita o `MailModule`.
- **Segundo fator de login (TOTP).**
- **Recusar senhas comuns ou vazadas.** A regra continua sendo o mínimo de 8 caracteres.
- **Aviso ao e-mail antigo quando o e-mail da conta muda.**

## Verificação

1. **Migration:** `prisma migrate dev` cria `password_reset_tokens`.
2. **Unitários da API**, no estilo de
   [whatsapp-link.service.spec.ts](apps/api/src/whatsapp-link/whatsapp-link.service.spec.ts):
   - `request`: conta existente cria token (só o hash) e chama o e-mail; inexistente não cria
     nada; 4º pedido da hora não cria nada; novo pedido expira o anterior; a resposta é igual nos
     três casos.
   - `complete`: troca a senha, consome o token, revoga sessões, registra o evento e envia o
     aviso; token inexistente, usado ou expirado falha com a mesma mensagem; corrida perdida
     (`count: 0`) não troca a senha.
   - `MailService`: escolhe o transport por env; em produção sem provedor, o boot falha; falha de
     envio não lança e não registra o e-mail em claro.
3. **Ponta a ponta local** (`MAIL_PROVIDER=log`): pedir o link em `/esqueci-senha`, copiar do
   console da API, abrir `/redefinir-senha#token=…`, definir a senha, entrar com a nova. Conferir:
   o link não funciona duas vezes; a sessão antiga cai; e-mail desconhecido recebe a mesma
   resposta; `user_security_events` tem os dois eventos.
4. **Envio real:** com as variáveis do Resend em um ambiente de teste, confirmar que o e-mail
   chega, que o link não foi reescrito pelo provedor e que SPF e DKIM passam.
5. **Web:** `tsc --noEmit` e `next lint`; conferência visual das duas telas em mobile, tablet e
   desktop. Não rodar `next build` com o `next dev` aberto.
6. **Build:** `nest build` e a suíte da API.

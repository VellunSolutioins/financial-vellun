# Plano — Recuperação de senha por e-mail

## Context

Hoje o app permite **trocar a senha logado** (com a senha atual), mas não há como
**recuperar** o acesso quando o usuário esqueceu a senha. Não existe nenhuma infra de e-mail no
projeto. Queremos o fluxo padrão: o usuário pede um link por e-mail, recebe um link com token de
uso único e curta duração, e define uma nova senha.

**Decisões:** provedor **Resend** (com um transport **"log"** para dev que imprime o link no
console, selecionado por env — mesmo padrão do messenger do WhatsApp); **rate limiting** com
`@nestjs/throttler` apenas nas rotas de recuperação.

**Pré-requisitos já prontos:** `@nestjs/config` e `bcryptjs` instalados; `ConfigService` já usado
no [auth.service.ts](apps/api/src/auth/auth.service.ts); `WEB_URL` já em env; componente
[PasswordInput](apps/web/src/components/ui/password-input.tsx) e o `apiClient` com refresh.
Dependências novas: `resend`, `@nestjs/throttler`.

## Arquitetura

```
Login → "Esqueci minha senha" → /esqueci-senha
  POST /auth/forgot-password { email }   (resposta SEMPRE genérica)
    → gera token aleatório, salva HASH + expiry (1h), envia e-mail com
      ${WEB_URL}/redefinir-senha?token=<plaintext>
/redefinir-senha?token=... (nova senha + confirmar)
  POST /auth/reset-password { token, newPassword }
    → valida (hash + não expirado + não usado) → atualiza senha (bcrypt) → marca token usado
```

Segurança: respostas **genéricas** (não revelam se o e-mail existe); token **aleatório de 32
bytes**, guardado **com hash SHA-256**, **uso único**, **TTL 1h**; tokens anteriores invalidados
ao pedir um novo; rotas públicas + throttled.

## Mudanças

### Backend (`apps/api`)

**1. Prisma — model de token** ([schema.prisma](apps/api/prisma/schema.prisma))

- Novo model `PasswordResetToken { id, userId, tokenHash @unique, expiresAt, usedAt?, createdAt }`
  com `user User @relation(onDelete: Cascade)` e índice em `userId`. Adicionar
  `passwordResetTokens PasswordResetToken[]` ao model `User`. Gerar migration
  (`prisma migrate dev --name add_password_reset_token`).

**2. Módulo de e-mail** — novo `src/mail/` (espelha o padrão factory+log do
`apps/ai-agent/src/services/messenger/factory.py`)

- `MailService` com método `sendPasswordReset(to, resetUrl)`.
- Transport selecionado por `MAIL_PROVIDER` (`log` | `resend`): **log** apenas registra o link
  (dev); **resend** usa o SDK `resend` com `RESEND_API_KEY` e `MAIL_FROM`. Falha de envio é
  logada, não vaza para a resposta. `MailModule` exporta `MailService`.

**3. Auth — endpoints** ([auth.service.ts](apps/api/src/auth/auth.service.ts) +
[auth.controller.ts](apps/api/src/auth/auth.controller.ts))

- `forgotPassword(email)`: busca usuário; se existir, apaga tokens não usados anteriores, gera
  token (`crypto.randomBytes(32).toString('hex')`), grava `sha256(token)` + `expiresAt = now+1h`,
  chama `mailService.sendPasswordReset`. **Sempre** retorna `{ message: genérico }`.
- `resetPassword(token, newPassword)`: calcula o hash, busca por `tokenHash`; valida não usado e
  não expirado (senão `BadRequestException` "Link inválido ou expirado"); atualiza
  `user.passwordHash` (bcrypt 12, como em `updatePassword`); marca `usedAt`. Retorno genérico.
- DTOs `ForgotPasswordDto { email @IsEmail }` e `ResetPasswordDto { token @IsString, newPassword
@MinLength(8) }`.
- Rotas `POST /auth/forgot-password` e `POST /auth/reset-password` (públicas — sem `JwtAuthGuard`),
  com `@UseGuards(ThrottlerGuard)` + `@Throttle` (ex.: 5/15min).

**4. Módulos** — `AuthModule` importa `MailModule` e `ThrottlerModule.forRoot(...)`
([auth.module.ts](apps/api/src/auth/auth.module.ts)). Não registrar guard global (escopo só nas
rotas de recuperação). Atualizar [.env.example](apps/api/.env.example) com `MAIL_PROVIDER=log`,
`RESEND_API_KEY=`, `MAIL_FROM=`.

### Frontend (`apps/web`)

**5. Telas** (em `app/(auth)/`, layout já existente)

- `esqueci-senha/page.tsx`: form de e-mail → `forgotPassword` → exibe mensagem genérica de sucesso
  ("Se o e-mail existir, enviamos um link…") com toast.
- `redefinir-senha/page.tsx`: lê `token` da query (`useSearchParams`, dentro de `<Suspense>`),
  nova senha + confirmar usando **`PasswordInput`**, validação Zod (mín. 8 + coincidência) →
  `resetPassword` → toast + redirect para `/login`. Sem token válido na URL, mostra erro.
- [login/page.tsx](<apps/web/src/app/(auth)/login/page.tsx>): adicionar link **"Esqueci minha
  senha"** → `/esqueci-senha`.

**6. Client + rotas públicas**

- [lib/auth.ts](apps/web/src/lib/auth.ts): `forgotPassword(email)` e `resetPassword(token,
newPassword)` (POST nas rotas; pulam refresh, pois são `/auth/*` — já tratado no api-client).
- [middleware.ts](apps/web/src/middleware.ts): adicionar `/esqueci-senha` e `/redefinir-senha` ao
  `PUBLIC_PATHS`.

### Fora de escopo (anotado para depois)

Revogar sessões/refresh tokens ativos após o reset exigiria um store/versão de token (hoje o
refresh é JWT stateless) — fica como melhoria futura.

## Verificação

1. **Migration:** `pnpm --filter @financial-vellun/api exec prisma migrate dev` cria a tabela.
2. **Unit (auth.service):** no estilo de
   [auth.service.spec.ts](apps/api/src/auth/auth.service.spec.ts), mockando prisma/mail: (a) forgot
   com e-mail existente gera token e chama o mail; (b) forgot com e-mail inexistente retorna
   genérico sem criar token; (c) reset com token válido troca a senha e marca `usedAt`; (d) reset
   com token expirado/usado/invalid → erro. Rodar `pnpm --filter @financial-vellun/api test`.
3. **E2E manual (MAIL_PROVIDER=log):** subir API+web; em `/login` clicar "Esqueci minha senha";
   enviar o e-mail do usuário; **copiar o link impresso no console** da API; abrir
   `/redefinir-senha?token=…`; definir nova senha; logar com a nova senha. Conferir: token **não**
   funciona uma 2ª vez; token expirado/alterado → erro; e-mail desconhecido → mesma mensagem
   genérica (sem vazar existência).
4. **Build/lint:** `nest build` (API) e `tsc --noEmit` + `next lint` (web) sem erros.

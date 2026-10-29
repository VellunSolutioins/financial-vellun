# Plano — Ajustes da recuperação de senha antes do merge

> **Status (2026-10-29): implementado** na branch `feat/recover-password` (PR #36), depois do
> merge da `main`. Diferenças em relação ao texto abaixo:
>
> - **Desvincular** ficou inline no card do WhatsApp, como "Trocar número", em vez de um
>   diálogo. Senha errada volta como erro do campo `currentPassword` (`400`), não `401`: assim
>   o cliente não tenta renovar a sessão à toa.
> - O aviso de senha alterada é um serviço próprio, `auth/password-change-notifier.service.ts`,
>   usado pela redefinição e pela troca logada.
> - `SecurityEventsService.record` com `db` **propaga** a falha (sem `db`, continua
>   best-effort): dentro da transação o evento é regra, porque o teto por hora conta esses
>   eventos.
> - Pendente fora do código: os pré-requisitos do Resend (Fase 3) e a conferência visual das
>   telas.

## Contexto

A recuperação de senha está implementada e os testes da API passam. A revisão encontrou dois
tipos de problema:

- **Pontos de segurança e operação** que a implementação não cobre:
  - quem perdeu a conta para um invasor não tem como tirar do vínculo o WhatsApp dele (não existe
    "desvincular");
  - ninguém é avisado quando a senha muda;
  - uma falha de envio de e-mail não aparece em lugar nenhum.
- **Divergência entre planos.** A branch seguiu a versão do plano de 2026-10-10. A `main` tem uma
  revisão de 2026-10-11 ([recuperacao-de-senha-por-email.md](recuperacao-de-senha-por-email.md),
  versão da `main`) com requisitos que não chegaram à branch:
  - token no fragmento (`#token=`), não na query;
  - e-mail "sua senha foi alterada";
  - limite de 3 pedidos por hora por conta;
  - validade de 30 min;
  - política de privacidade citando o serviço de e-mail;
  - documentação (`CLAUDE.md`, Railway).

  É por isso que o documento de plano conflita no merge.

## Decisões (Bruno, 2026-10-29)

| #   | Decisão                                     | Resolução                                                                                                                                                                                                |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | A redefinição desfaz o vínculo do WhatsApp? | **Não.** Quem só esqueceu a senha não deve perder o WhatsApp. Em vez disso, um botão **"Desvincular"** em Minha Conta, e o aviso de senha alterada mostra o número vinculado para quem não o reconhecer. |
| D2  | Validade do link                            | **30 min** (hoje 60).                                                                                                                                                                                    |
| D3  | Limite por conta                            | **Manter 1/min e somar teto de 3/hora.**                                                                                                                                                                 |
| D4  | E-mails que diferem só por maiúsculas       | **Sem ação.** Ainda não há dados relevantes em produção. Cadastro e edição já normalizam o e-mail.                                                                                                       |

## Fase 0 — Sincronizar com a `main`

1. `git merge main` na branch.
2. Resolver [recuperacao-de-senha-por-email.md](recuperacao-de-senha-por-email.md): partir da
   versão da `main`, porque ela tem o "Por que não WhatsApp", a seção de LGPD e os pré-requisitos.
   Trocar o aviso "Não implementado" do topo pelo bloco de status da branch (o que foi feito e as
   diferenças), apontando para este plano.
3. `prisma generate` e `prisma migrate deploy` locais.

## Fase 1 — Segurança

### 1. Token no fragmento da URL

Hoje o link é `/redefinir-senha?token=…`. A query string fica nos logs HTTP da plataforma que
serve o web, e o token vale até 30 min. O fragmento (`#token=…`) não sai do navegador.

- **API** — [password-reset.service.ts](../apps/api/src/auth/password-reset.service.ts): montar
  `resetUrl` com `#token=`.
- **Web** — [reset-password-form.tsx](../apps/web/src/components/auth/reset-password-form.tsx):
  - trocar `useSearchParams` por leitura de `window.location.hash` num `useEffect` de montagem;
  - guardar o token em estado e, em seguida, limpar a barra com
    `history.replaceState(null, '', location.pathname)`;
  - enquanto o token não foi lido, não renderizar nada (evita piscar a tela de link inválido);
  - sem token, a mensagem passa a orientar: "abra de novo o link do e-mail". Recarregar a página
    perde o token de propósito.
- **Página** — [redefinir-senha/page.tsx](<../apps/web/src/app/(auth)/redefinir-senha/page.tsx>):
  sem `useSearchParams`, o `Suspense` sai. `referrer: 'no-referrer'` fica.
- A branch não foi publicada, então não é preciso aceitar `?token=` por compatibilidade.

### 2. Validade de 30 min e teto de 3 pedidos por hora (D2, D3)

- `RESET_TOKEN_TTL_MINUTES = 30`. O template e a tela já leem o valor da resposta.
- `RESET_REQUESTS_PER_HOUR = 3`. Dentro da transação com o advisory lock do `issueAndSend`, contar
  os eventos `password_reset_requested` da conta na última hora e não emitir quando chegar a 3. A
  tabela de tokens não serve para isso: pedir um link novo apaga os anteriores.
- Para a contagem valer sob concorrência, o evento passa a ser gravado **dentro** da transação:
  `SecurityEventsService.record` ganha um parâmetro `db`, como o `revokeAllForUser`. O índice
  `user_security_events(user_id, created_at)` já existe.
- A resposta continua igual nos três casos (conta inexistente, dentro do limite, acima dele).

### 3. Desvincular o WhatsApp em Minha Conta (D1)

Hoje o vínculo só muda trocando de número. Quem retoma a conta não tem como tirar o número de um
invasor, que continua lançando e lendo categorias e contas pelo bot.

**API** ([whatsapp-link/](../apps/api/src/whatsapp-link/)):

- `WhatsappLinkService.unlink(userId, currentPassword, context)`:
  - **exige a senha atual**, como a troca de número, para que uma sessão roubada não consiga
    derrubar o WhatsApp do dono;
  - numa transação:
    - revoga o contato ativo (`isVerified: false`, `revokedAt`, `linkVersion + 1`);
    - fecha as conversas ativas;
    - apaga os desafios pendentes (`phoneVerification` com `consumedAt: null`).

    Generalizar o `revokeOtherContacts` existente (com `keepId` opcional) em vez de duplicar a
    lógica.

  - sem vínculo, responde `404` com mensagem clara;
  - registra o evento `phone_unlinked` (novo tipo em `SecurityEventType` e no comentário do model
    `UserSecurityEvent`), com o número mascarado no metadata.

- Rota `POST /users/me/phone/unlink` `{ currentPassword }`, com `JwtAuthGuard`, throttle de 5/min
  e DTO com `@ApiProperty`. `POST` porque `DELETE` com corpo é mal suportado por proxies e
  clientes.
- O campo `users.phone` (dado de cadastro) não muda. Só o vínculo sai.
- O agente não muda: o `isLinked` do
  [internal.service.ts](../apps/api/src/internal/internal.service.ts) já ignora contato revogado,
  e o `linkVersion` incrementado descarta as confirmações pendentes. Conferir no teste ponta a
  ponta que o bot passa a tratar o número como não vinculado.

**Web** ([whatsapp-card.tsx](../apps/web/src/components/whatsapp/whatsapp-card.tsx)):

- Botão **"Desvincular"** ao lado de "Trocar número", só com vínculo ativo.
- Abre um diálogo ([dialog.tsx](../apps/web/src/components/ui/dialog.tsx)). Ele:
  - explica o efeito: "esse número deixa de lançar na sua conta; para voltar, é só vincular de
    novo";
  - pede a senha atual (`PasswordInput`).
- Erro de senha aparece no campo. No sucesso, toast e o card volta ao estado "sem número
  vinculado".
- `unlinkWhatsapp({ currentPassword })` em [whatsapp.ts](../apps/web/src/lib/whatsapp.ts).
- Mobile first: botões empilhados e em largura total no celular. Diálogo sem rolagem horizontal e
  com o teclado aberto.

### 4. Aviso "sua senha foi alterada"

- `mail/password-changed.template.ts`, no mesmo formato do
  [password-reset.template.ts](../apps/api/src/mail/password-reset.template.ts). Conteúdo:
  - data e hora da troca (fuso `America/Sao_Paulo`);
  - se foi por redefinição, que as sessões foram encerradas;
  - **se houver WhatsApp vinculado**, o número mascarado (`(41) •••••-1234`), "não reconhece?
    desvincule em Minha Conta" e o link para `${WEB_URL}/app/conta`. É a contrapartida da D1: quem
    retoma a conta fica sabendo do número sem que ele seja desfeito à força;
  - "não foi você?" com link para `${WEB_URL}/esqueci-senha`;
  - sem IP nem aparelho, para não pôr dado pessoal no e-mail.
- `MailService.sendPasswordChanged`.
- Chamar depois da transação, sem `await` no caminho da resposta (a senha já mudou; falha de
  envio só é registrada, item 6), em dois lugares:
  - `PasswordResetService.resetPassword` — pegar `email` e `name` no `tx.user.update` com
    `select`, e o número vinculado com uma consulta ao `whatsappContact` ativo;
  - `UsersService.changePassword` em [users.service.ts](../apps/api/src/users/users.service.ts) —
    o `UsersModule` passa a importar o `MailModule`.

### 5. Limpar cookies de sessão na redefinição

[auth.controller.ts](../apps/api/src/auth/auth.controller.ts): `reset-password` recebe
`@Res({ passthrough: true })` e chama `sessions.clearAuthCookies(res)` no sucesso. Assim um
navegador que ainda tinha cookies da sessão revogada não fica com lixo.

## Fase 2 — Observabilidade

### 6. Métrica e alerta de envio de e-mail

- [metrics.service.ts](../apps/api/src/observability/metrics.service.ts): contador
  `vellun_api_mail_sent_total` com labels `template` (`password_reset`, `password_changed`) e
  `result` (`sent`, `failed`, `skipped`). Inicializar as combinações em 0 no construtor, para as
  séries existirem antes do primeiro envio. É a mesma lição dos alertas de pagamento, inertes até
  existirem.
- [mail-transport.ts](../apps/api/src/mail/mail-transport.ts): `send` passa a retornar
  `'sent' | 'skipped'`. O `LogMailTransport` em produção retorna `skipped`.
- [mail.service.ts](../apps/api/src/mail/mail.service.ts) registra o resultado. Exceção conta como
  `failed` e é relançada. O `ObservabilityModule` é `@Global`, então não precisa de import.
- [plataforma.yaml](../infra/observability/alerts/plataforma.yaml):
  - `EmailTransacionalFalhando`:
    `increase(vellun_api_mail_sent_total{result="failed"}[15m]) > 0`, severidade `warning`;
  - `EmailNaoEnviadoEmProducao`: `increase(...{result="skipped", env="production"}[1h]) > 0`,
    severidade `warning`;
  - casos nos testes em
    [plataforma.test.yaml](../infra/observability/alerts/tests/plataforma.test.yaml).

## Fase 3 — LGPD e documentação

### 7. Política de privacidade e docs

- [privacidade/page.tsx](../apps/web/src/app/privacidade/page.tsx): incluir o serviço de envio de
  e-mails entre os prestadores e atualizar a data.
- [infra/railway/README.md](../infra/railway/README.md): `MAIL_PROVIDER`, `RESEND_API_KEY` e
  `MAIL_FROM` no serviço da API.
- [CLAUDE.md](../CLAUDE.md):
  - `mail/` na estrutura da API;
  - `esqueci-senha` e `redefinir-senha` em `app/(auth)/`.
- Plano original: status final, com as decisões D1–D4.

**Pré-requisitos fora do código** (Bruno), da revisão de 2026-10-11:

- domínio verificado no Resend com SPF, DKIM e DMARC;
- **rastreamento de clique e de abertura desligado**, porque ele reescreve o link e passa o token
  pelo servidor do provedor;
- chave restrita a envio.

## Fase 4 — Menor

### 8. Comentário duplicado

[session.service.ts](../apps/api/src/auth/session.service.ts): juntar os dois blocos `/** */` do
`revokeAllForUser` num só.

## Ordem e tamanho

| Ordem | Item                        | Tamanho |
| ----- | --------------------------- | ------- |
| 1     | Fase 0 — merge da `main`    | P       |
| 2     | 1 — token no fragmento      | P       |
| 3     | 2 — 30 min e 3/hora         | P       |
| 4     | 3 — desvincular WhatsApp    | M       |
| 5     | 4 — aviso de senha alterada | M       |
| 6     | 5 — limpar cookies          | P       |
| 7     | 6 — métrica e alertas       | M       |
| 8     | 7 — LGPD e docs             | P       |
| 9     | 8 — comentário duplicado    | P       |

O item 4 usa o número vinculado e aponta para o botão do item 3. Fazer nessa ordem evita
retrabalho no texto do e-mail.

## Verificação

1. **Unitários da API** (estender os specs existentes):
   - `password-reset.service.spec.ts`:
     - link com `#token=` e validade de 30 min;
     - 4º pedido na hora não emite e responde igual;
     - evento gravado dentro da transação;
     - a redefinição **não** mexe no vínculo do WhatsApp;
     - aviso de senha alterada disparado (com e sem número vinculado), e falha no envio não
       derruba a resposta.
   - `whatsapp-link.service.spec.ts` — `unlink`:
     - senha errada recusa;
     - sem vínculo dá 404;
     - com vínculo revoga, incrementa `linkVersion`, fecha conversas, apaga desafios pendentes e
       registra `phone_unlinked`.
   - `users.service.spec.ts`: a troca logada envia o aviso.
   - `mail.spec.ts`: template novo; métrica `sent`, `failed` e `skipped`.
2. **Alertas:** `promtool test rules` com os casos novos.
3. **Ponta a ponta local** (`MAIL_PROVIDER=log`):
   - pedir o link, abrir `/redefinir-senha#token=…` e conferir que a barra fica limpa;
   - redefinir a senha e conferir:
     - o aviso no console, com o número mascarado;
     - o WhatsApp ainda vinculado;
     - a sessão antiga caída;
   - o 4º pedido na hora não gera e-mail;
   - desvincular em Minha Conta (senha errada e certa) e mandar mensagem ao bot pelo número
     desvinculado: ele não pode lançar na conta.
4. **Web:**
   - `tsc --noEmit` e `next lint`;
   - conferência visual de `/redefinir-senha` e do card do WhatsApp com o diálogo, em mobile,
     tablet e desktop;
   - não rodar `next build` com o `next dev` aberto.
5. **Envio real** num ambiente de teste com Resend: o link chega sem ser reescrito, e SPF e DKIM
   passam.

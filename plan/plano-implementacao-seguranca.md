# Plano de implementação — Segurança

Data: 22/09/2026. **Base: branch `main`** (commit `2fca515`).
Origem: [análise de segurança](../docs/analise-seguranca-2026-09-21.md), analisada em conjunto com as
[recomendações de performance](../docs/financial-vellun-recomendacoes-performance-escalabilidade-disponibilidade.md).
Plano irmão: [plano de implementação de performance](plano-implementacao-performance.md).

> O relatório de segurança foi produzido sobre a `feature/melhorias`, por isso algumas referências
> de linha dele não batem com a `main`. Este plano usa as referências da `main`. Itens que só existem
> na `feature/melhorias` (Membros/Duo, convites) estão na seção
> [Quando a feature/melhorias for integrada](#quando-a-featuremelhorias-for-integrada).

Decisões já tomadas:

- **Posse do número de WhatsApp:** o usuário envia ao bot um código exibido na tela (reverse OTP),
  por link `wa.me` (smartphone) ou por link e QR code (computador). O número de origem vem do webhook
  assinado pela Meta; não exige template de autenticação.
- **Redis entra na API** (`RedisModule` único), criado neste plano e reaproveitado pelo de performance.

## Estado atual na `main`

**Sessões**

- Não há tabela de sessão nem versão de token. O payload do JWT é `{sub, email}`
  (`apps/api/src/auth/auth.service.ts:149-162`); access token de 15 min e refresh de 7 dias.
- `jwt.strategy.ts:22-26` já lê o usuário a cada request. `jwt-refresh.strategy.ts:22-26` só checa se
  o usuário existe, e o refresh (`auth.service.ts:131-133`) emite um novo par sem invalidar o anterior.
- Logout (`auth.controller.ts:42-48`) só apaga cookies. Troca de senha (`users.service.ts:79-90`) só
  grava o novo hash. `COOKIE_OPTIONS` fica em `auth.controller.ts:14-18`.

**Telefone**

- `isVerified: true` é gravado sem desafio no cadastro (`auth.service.ts:88-101`) e na edição de perfil
  (`users.service.ts:141-157`, `linkWhatsappContact`), com checagem prévia seguida de `upsert`, sem
  atomicidade. O número antigo nunca é desvinculado.
- `findContactByPhone` (`internal/internal.service.ts:41-57`) devolve o usuário sem olhar
  `isVerified`. O agente também não olha (`contact_service.py:14`).
- A boas-vindas é disparada logo após o cadastro (`auth.service.ts:106-113`) como texto livre
  (`cloud_api_messenger.py:62`). Para um número que nunca falou com o bot, a Meta tende a rejeitar
  por estar fora da janela de 24 h. Vale confirmar pelo contador `whatsapp_send_failed`.
- O ponto do agente que trata número não vinculado é `inbound_consumer.py:130-143`.

**Webhook e agente**

- `ENVIRONMENT` tem default `development` (`config.py:28`). Sem segredo, `_verify_signature`
  (`webhook.py:56`) aceita tudo fora de produção.
- Não há limite de corpo (`webhook.py:135`). A mídia é baixada inteira antes do limite
  (`whatsapp_media.py:54-61`), com um client novo a cada download.
- `LogMessenger` loga telefone e texto completos (`log_messenger.py:12`).

**API e infraestrutura**

- Throttler em memória (`app.module.ts:31`), sem `trust proxy`, e a API não usa Redis.
- A allowlist aceita localhost e a regex de previews Vercel em qualquer ambiente
  (`common/http-origin.util.ts`). Login e cadastro são isentos de CSRF (`csrf.guard.ts:31`).
- O docker-compose publica Postgres, Redis e RabbitMQ em todas as interfaces
  (`infra/docker/docker-compose.yml:11, 37-39, 60`). Redis não tem senha e o RabbitMQ usa `guest` como fallback.
- `Dockerfile.ai-agent` roda como root. As dependências Python só têm `>=`. Não há CI (`.github/`) nem
  `railway.toml`. O Next.js é `^14.2.29` e `next.config.js` não define headers.
- A sessão de ops renova continuamente, sem prazo absoluto (`ops/auth/*`, código igual ao analisado no relatório).

## Contrato de coordenação com o plano de performance

> Seção idêntica nos dois planos. Cada decisão tem **um dono**; o outro plano apenas consome.

| #   | Tema                                 | Dono                                                                         | Regra acordada                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Redis na API                         | Segurança (S2)                                                               | `RedisModule` em `apps/api/src/redis/` (ioredis). Prefixos `rl:` (throttler) e `cache:` (performance). Mesma instância do agente, prefixos separados.                                                                                                                                                                                        |
| C2  | Revogação de sessão sem custo extra  | Segurança (S1)                                                               | A validação da sessão substitui a leitura de usuário que já existe na `jwt.strategy` (1 query com `include`). **Sessão e usuário nunca vão para cache.**                                                                                                                                                                                     |
| C3  | Identidade por telefone              | Segurança (S1)                                                               | `GET /internal/whatsapp/contacts/:phone` e `subscription-access` **não são cacheáveis** (nem no agente, nem na API). Performance otimiza com memo por job e índices.                                                                                                                                                                         |
| C4  | Estado conversacional pendente       | Segurança (S1)                                                               | `conv:{phone}` passa a guardar `userId`, `contactId` e `linkVersion`. Ao concluir uma confirmação o agente re-resolve a identidade e descarta o estado se divergir. A API não precisa apagar chaves do agente.                                                                                                                               |
| C5  | Fila outbound                        | Performance (P3)                                                             | Contrato `OutboundMessageV1` em `messaging/contracts.py` com `schemaVersion`, `userId`, `contactId`, `jobId`. Toda resposta, inclusive a boas-vindas enviada após o reverse OTP, passa por ela quando existir. O outbound worker só envia; não decide identidade.                                                                            |
| C6  | Migrations Prisma                    | Ambos                                                                        | Migrations pequenas e separadas (`YYYYMMDDHHMMSS_snake_case`). Segurança: `user_sessions`, `phone_verifications`, campos de vínculo em `whatsapp_contacts` (`verified_at`, `revoked_at`, `link_version`) e `@@index([userId])` nela. Performance: índices de `Transaction` e `AiConversation`. Nenhum plano cria índice que o outro já cria. |
| C7  | PgBouncer × transações atômicas      | Performance (P2)                                                             | Pool em _transaction mode_ com `pgbouncer=true` e `directUrl` para migrations. As operações atômicas da segurança usam transação interativa ou `updateMany` condicional, **sem** advisory lock de sessão, `LISTEN` ou prepared statements nomeados.                                                                                          |
| C8  | Config inválida × readiness          | Segurança (S1) define boot; Performance (P1) define readiness                | Configuração inválida ou insegura → **falha no boot**. Dependência indisponível → **readiness 503**.                                                                                                                                                                                                                                         |
| C9  | Webhook assinado × loadtest          | Segurança (S1)                                                               | Bypass de assinatura só com `WEBHOOK_ALLOW_UNSIGNED=true` **e** ambiente local. `scripts/loadtest.py` passa a assinar os payloads com HMAC.                                                                                                                                                                                                  |
| C10 | docker-compose, Dockerfile, Railway  | Segurança define as regras (S1/S3); Performance adiciona serviços (P1/P2/P6) | Portas em `127.0.0.1`, Redis com senha, RabbitMQ sem `guest`; serviços novos (PgBouncer) seguem as mesmas regras. Dockerfile do agente com `USER` não-root serve HTTP e worker. `railway.toml` (performance) inclui o checklist de rede privada (segurança).                                                                                 |
| C11 | Escalar a API horizontalmente        | Performance (P6)                                                             | **Bloqueado até** throttler em Redis + `trust proxy` (S2).                                                                                                                                                                                                                                                                                   |
| C12 | Rate limit por usuário/telefone      | Segurança (S2)                                                               | Limites calibrados acima do perfil de loadtest (P5); o loadtest usa muitos telefones distintos. Rejeições por limite viram métrica.                                                                                                                                                                                                          |
| C13 | Métricas                             | Ambos                                                                        | Mesmo registry (`services/metrics.py` no agente; `observability/` na API), prefixos `vellun_agent_*` / `vellun_api_*`, sem telefone ou PII em labels.                                                                                                                                                                                        |
| C14 | Retenção de `AiMessage` / `rawInput` | Segurança (S4)                                                               | Job de purga em lotes pequenos, fora de pico, dentro do connection budget (P2).                                                                                                                                                                                                                                                              |
| C15 | Integração da `feature/melhorias`    | Ambos                                                                        | Os planos valem para a `main`. Ao integrar a `feature/melhorias`, aplicar os itens da seção "Quando a feature/melhorias for integrada" de cada plano antes do merge em produção.                                                                                                                                                             |

**Ordem global intercalada:** S1 → P1 → S2 → P2 → P3 → S3 → P4/P5 → S4 → P6.

---

## S1 — Crítico: identidade, sessões, webhook, portas

> **Status (22/09/2026): implementado na branch `feat/seguranca-s1`**, migration
> `20260922120000_add_sessions_and_phone_verification`. Decisões tomadas na
> implementação que ajustam o texto abaixo:
>
> - **Vínculo pendente:** não existe status `pending` em `WhatsappContact`. O desafio
>   pendente vive só em `phone_verifications`; o contato só é criado/atualizado quando o
>   código é confirmado. `WhatsappContact` manteve `isVerified` e ganhou `verifiedAt`,
>   `revokedAt` e `linkVersion`. Identifica o usuário: `userId` + `isVerified` + não revogado.
> - **Número vinculado:** o código só vale se enviado do número informado (com tolerância
>   ao nono dígito, `phoneVariants`), e o contato gravado é o número de origem que a Meta
>   informou. Quem prova a posse leva o número, mesmo que outra conta o tivesse.
> - **Cadastro:** deixou de consultar se o telefone já pertence a outra conta (revelava
>   quais números têm cadastro).
> - **Código solto:** "Código: 123456" é conferido sempre; seis dígitos sozinhos só para
>   número sem vínculo (senão "150000" como resposta de valor seria interceptado).
> - **Sessões:** o refresh gira na própria linha da sessão (sem `familyId`/`replacedById`);
>   reutilização revoga a sessão. `sessionVersion` não foi necessário: revogar todas é um
>   `updateMany`. Janela de 60 s tolera duas abas renovando juntas. Prazo absoluto: 30 dias.
> - **Troca de senha:** encerra as **outras** sessões e mantém a atual.
> - **Notificar o destino anterior** na troca de e-mail/telefone ficou pendente: a `main`
>   não tem envio de e-mail.
> - **`LogMessenger`:** mantém o texto da resposta só em ambiente local (é para isso que o
>   provider existe); o número sai sempre mascarado. Fora do local o boot já recusa `log`.
> - **`ENVIRONMENT`:** qualquer valor fora de `development`/`dev`/`local`/`test`
>   (inclusive ausente) recebe as regras de produção.

### S1.1 Verificação de posse do telefone (reverse OTP) — relatório §1

- **Schema:** `WhatsappContact` ganha `status` (`pending | verified | revoked`), `verifiedAt`,
  `revokedAt`, `linkVersion` e `@@index([userId])`. Nova tabela `PhoneVerification`: `userId`,
  `phoneNumber`, `codeHash`, `expiresAt` (10 min), `attempts` (máx. 5), `consumedAt`.
- **API:** cadastro (`auth.service.ts:88-101`) e edição (`users.service.ts:141-157`) deixam de gravar
  `isVerified: true`. Criam uma verificação pendente e devolvem para a tela o código, o número do bot
  e o link `waLink` (`https://wa.me/<WHATSAPP_BOT_NUMBER>?text=<mensagem com o código>`). Endpoints:
  - `POST /users/me/phone/verification` gera ou regenera o código, com throttle próprio;
  - `GET /users/me/phone/verification` devolve o status (`pending | verified | expired`), para a tela avançar sozinha.
  - O número do bot vem de uma variável única da API (`WHATSAPP_BOT_NUMBER`), para web e API não divergirem.
- **Tela de verificação (web, mobile first):**
  - **Smartphone (base):**
    - botão principal "Verificar pelo WhatsApp", que abre o `waLink` com a mensagem já preenchida;
    - o usuário só toca em enviar;
    - o QR code não aparece nesse layout.
  - **Computador (breakpoint `md`+):**
    - o QR code do mesmo `waLink` aparece ao lado do botão;
    - o usuário pode ler o QR com o celular ou clicar no link, que abre o WhatsApp Desktop ou o WhatsApp Web;
    - QR gerado no cliente (ex.: `qrcode.react`), sem serviço externo, para o código não sair do navegador.
  - **Comum aos dois:**
    - número do bot em texto, para salvar o contato;
    - código visível, para quem preferir digitar;
    - contagem regressiva da expiração, com "gerar novo código";
    - polling do status a cada ~3 s: quando o usuário valida pelo celular, a tela do computador avança sozinha.
  - **Mensagem pré-preenchida legível**, ex.: "Olá! Quero ativar meu WhatsApp no Financial Vellun. Código: 123456".
    O agente extrai o código por regex, tolerando edição do texto ao redor.
  - **Quem sair da tela sem verificar:** banner persistente no app e atalho em "Minha Conta" para retomar.
  - **Onde entra:** passo após o cadastro em `app/(auth)/cadastro` e na edição do telefone em `app/app/conta`.
- **Boas-vindas:** deixa de ser disparada no cadastro (`auth.service.ts:106-113`) e passa a ser a
  resposta do bot à mensagem de verificação. Como o usuário acabou de escrever, a janela de 24 h da
  Meta está aberta e o texto livre é entregue sem template. Também para de mandar mensagem, com o
  nome do cadastrante, a um número não comprovado. Reaproveita `build_welcome_message`
  (`welcome_service.py:21`). A rota `POST /internal/notifications/welcome` e o
  `WelcomeNotificationService` da API deixam de ser chamados no cadastro.
- **Agente:** no ramo de número não vinculado (`inbound_consumer.py:130-143`), se o texto casar com o
  padrão do código, chama `POST /internal/whatsapp/verify {phone, code}` em vez de responder
  `NOT_LINKED_MESSAGE`. Sucesso → boas-vindas; falha → mensagem orientando a gerar um novo código.
- **Confirmação atômica na API:** numa transação, compara o hash do código e checa tentativas e
  expiração. O claim do número usa `SELECT ... FOR UPDATE` (padrão de `internal.service.ts:386`),
  unicidade de `phoneNumber` e tratamento de P2002. Duas reivindicações concorrentes têm um único vencedor.
- **Resolução de identidade:** `findContactByPhone` (`internal.service.ts:41-57`) só devolve o
  usuário se `status = verified`. Um contato `pending` continua caindo no ramo "não vinculado" do agente.
- **Dados existentes:** contatos já vinculados migram como `verified` (legado), com opção de pedir
  reverificação.

### S1.2 Troca de telefone revoga o número anterior — §2

- Na confirmação do novo número, na mesma transação:
  - contatos antigos do usuário → `revoked` (o `userId` fica para auditoria);
  - conversas `active` desses contatos → `closed`;
  - `linkVersion` é incrementado.
- `updateUser` (`users.service.ts:92-128`) deixa de gravar `phone` direto: o telefone só muda no
  perfil depois da verificação.
- Conforme C4, o estado `conv:{phone}` (`conversation_store.py:122`, `conversation_manager.py:62`)
  carrega `userId`, `contactId` e `linkVersion`. O `message_processor` re-resolve a identidade antes de
  concluir uma confirmação pendente e descarta o estado se divergir.
- Troca de e-mail ou telefone exige a senha atual e notifica o destino anterior. O e-mail passa a ser
  normalizado (trim + minúsculas) no cadastro, no login e na edição.

### S1.3 Sessões revogáveis — §3

- **Schema:** nova `UserSession` (`id`, `userId`, `refreshTokenHash`, `familyId`, `createdAt`,
  `lastUsedAt`, `expiresAt`, `absoluteExpiresAt`, `revokedAt`, `replacedById`, `userAgent`, `ip`) e
  `User.sessionVersion`.
- **`SessionService` único:** centraliza a emissão de tokens e cookies hoje em `auth.service.ts:149-162`
  e `auth.controller.ts:14-18`. Payload `{sub, sid, sv, typ}`.
- **Refresh:** rotação de uso único via
  `updateMany({ where: { id, refreshTokenHash, revokedAt: null } })`. Se nenhuma linha for
  atualizada, houve reutilização e a família inteira é revogada. Cookie de refresh com `path=/auth/refresh`.
- **Validação por request:** em `jwt.strategy.ts:22`, uma query
  `userSession.findUnique({ include: { user } })` substitui a leitura atual (C2). Rejeita sessão
  revogada ou `sv` divergente. `jwt-refresh.strategy.ts:22` valida contra a tabela.
- **Revogação:**
  - logout revoga a sessão atual;
  - troca de senha (`users.service.ts:79-90`) incrementa `sessionVersion` e revoga todas as sessões;
  - novo endpoint "encerrar todos os dispositivos".
- Incluir os cookies novos em `SESSION_COOKIES` (`csrf.guard.ts:18`).

### S1.4 Webhook seguro por padrão — §4

- `config.py`: `environment` passa a ter default `production`. Um validador pydantic no boot exige:
  - `whatsapp_webhook_secret`;
  - `internal_api_key` não vazia e com tamanho mínimo;
  - `metrics_token`;
  - provider diferente de `log` fora do ambiente local.
- Bypass de assinatura só com `WEBHOOK_ALLOW_UNSIGNED=true` + ambiente local (C8, C9).
- `.env.example` do agente passa a declarar `ENVIRONMENT=development` e
  `WEBHOOK_ALLOW_UNSIGNED=true` explicitamente, para o `pnpm dev` continuar funcionando.
- `LogMessenger` (`log_messenger.py:12`) passa a usar `safe_phone` e não loga o texto completo.
- `scripts/loadtest.py` passa a assinar os payloads com HMAC.

### S1.5 Exposição de infraestrutura — §6

- `infra/docker/docker-compose.yml`: `127.0.0.1:` em todas as portas, `requirepass` no Redis e remoção
  do fallback `guest`.
- Atualizar os três `.env.example` (api, ai-agent, infra) com `REDIS_URL` autenticada, e o CLAUDE.md
  (tabela de serviços cita `guest/guest`).
- **Checklist Railway:**
  - Postgres, Redis e RabbitMQ sem domínio público;
  - rotacionar as credenciais do RabbitMQ (pendência registrada em `docs/alloy-no-railway-plan.md`).

## S2 — Alto: origens, limites, Redis/rate limit, ops

> **Status (22/09/2026): implementado na branch `feat/seguranca-s1`**, sem migration.
> Decisões tomadas na implementação:
>
> - **Origens:** em produção só `WEB_URL`, `WEB_ALLOWED_ORIGINS` e o domínio de produção do
>   frontend. Previews da Vercel e localhost só fora de produção; um preview que precise da
>   API de produção entra por `WEB_ALLOWED_ORIGINS`, com a origem exata. Login e cadastro
>   continuam sem token CSRF, mas recusam `Origin` desconhecido.
> - **Corpo do webhook:** limite de 1 MB (`WEBHOOK_MAX_BODY_BYTES`) aplicado na própria
>   rota, lendo em stream; `Content-Length` acima do limite recusa sem ler.
> - **Mídia:** client único, download em stream interrompido no limite, redirecionamento
>   manual só para hosts da Meta (e o da própria API), token nunca enviado a outro host.
> - **Rate limit:** `@nest-lab/throttler-storage-redis` embrulhado num storage que cai para a
>   contagem em memória se o Redis falhar (a API não devolve 500 por causa do contador).
>   Sem `REDIS_URL`, conta em memória com aviso. Chave por usuário quando o access token é
>   válido (assinatura verificada no próprio guard), senão por IP; prefixo `rl:`.
>   `TRUST_PROXY` padrão 1 em produção.
> - **Custo de IA:** `AI_DAILY_MESSAGE_LIMIT` (200/telefone/dia; 0 desliga), contado antes de
>   LLM, transcrição e visão. Comprovante conta uma vez só.
> - **Painel de ops:** prazo absoluto de 12 h desde o login (claim `auth`, preservada nas
>   renovações; sessões antigas sem ela são recusadas). A organização no GitHub é revalidada
>   a cada renovação com `OPS_GITHUB_ORG_TOKEN` (opcional); só "não é membro" explícito
>   derruba — sem token ou sem resposta, vale o prazo absoluto. MFA na organização é
>   configuração do GitHub, fora do código.
> - **Chaves internas:** `INTERNAL_API_KEY_AGENT_TO_API` e `INTERNAL_API_KEY_API_TO_AGENT`;
>   a `INTERNAL_API_KEY` antiga segue aceita e é o fallback de envio até ser removida.

- **CORS/CSRF (§5):**
  - `http-origin.util.ts` com allowlist exata por ambiente (`WEB_ALLOWED_ORIGINS`);
  - regex de preview e localhost só fora de produção;
  - login e cadastro, isentos em `csrf.guard.ts:31`, passam a exigir Origin permitido (contra login CSRF).
- **Limites de tamanho (§7):**
  - middleware ASGI no agente limita os bytes do webhook antes de `request.body()` (ex.: 1 MB) e checa `Content-Length`;
  - mídia baixada com `client.stream()`, abortando ao passar `media_max_bytes`;
  - um `AsyncClient` único e reutilizado, o que também ajuda a performance;
  - validação de redirects e remoção do log de `meta.text`.
- **Redis na API (C1) e throttler compartilhado:**
  - `RedisModule` + storage Redis para o `@nestjs/throttler` (`app.module.ts:31`);
  - `app.set('trust proxy', …)` em `main.ts`, conforme o proxy do Railway;
  - `getTracker` por usuário autenticado + IP.
- **Limites no agente (C12):** contador Redis por telefone/dia para o custo de processamento de IA.
- **Sessão ops (§8):**
  - prazo absoluto (ex.: 12 h) no payload de `ops_session` (`ops-session.service.ts`);
  - revalidação do membership GitHub na renovação (`ops-auth.guard.ts`, `github-oauth.client.ts`);
  - procedimento de desligamento documentado;
  - MFA exigido na organização GitHub.
- **API interna:** chaves separadas por direção (agente→API e API→agente), com período de convivência
  para rotação.

## S3 — Médio: dependências, supply chain, container

> **Status (22/09/2026): implementado na branch `feat/seguranca-s1`, menos a migração do
> Next.js.** Decisões e achados:
>
> - **Lock Python:** `apps/ai-agent/requirements.lock` com versões fixas e hashes, gerado
>   dentro de `python:3.12-slim` (no Windows, o resolvedor descartaria `uvloop`/`httptools`).
>   A suíte foi rodada no container com as versões travadas antes de adotá-las. A imagem e o
>   CI instalam com `--require-hashes`; `requirements.txt` segue como lista de diretas.
> - **Container:** `Dockerfile.ai-agent` com base fixada por digest, instalação pelo lock,
>   usuário `agent` (uid 10001) e `HEALTHCHECK` via `urllib` (sem curl na imagem).
> - **Frontend:** headers em `next.config.js` (CSP em `Report-Only`, `X-Frame-Options`,
>   `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS) e `poweredByHeader: false`.
>   A CSP fica em relatório porque o runtime do Next injeta script e estilo inline.
> - **CI** (`.github/workflows/ci.yml`): lint/tipos/testes da API e do web, testes do agente
>   pelo lock, `pnpm audit` + `pip-audit` e gitleaks com histórico completo.
>   - A auditoria entra como **informativa** (`continue-on-error`): hoje o repositório tem 93
>     avisos, 3 críticos. Virar bloqueante quando o passivo for zerado.
>   - `pnpm format:check` ficou fora: ~196 arquivos (docs e planos) estão fora do padrão;
>     entra depois de um commit de faxina só com formatação.
> - **`packageManager`** passou a `pnpm@10.15.0`, que é quem escreveu o `pnpm-lock.yaml` e
>   instalou o `node_modules`; com 9.0.0 declarado, o pnpm local falhava por store
>   incompatível.
> - **Pendente — Next.js:** a auditoria aponta **duas RCE críticas** corrigidas só a partir
>   de 15.5.24 (a linha 14 não tem correção): execução remota em servidor hospedado em
>   Windows e na API de otimização de imagem com AVIF. O app não usa `next/image`, e a
>   hospedagem é Vercel (Linux), o que reduz a exposição, mas não a elimina. A migração para
>   Next 15 exige React 19 e revisão do web inteiro, então fica em branch própria, com
>   verificação manual no navegador.

- Migrar `apps/web` para uma linha suportada do Next.js, em branch próprio (§9).
- `next.config.js` com headers de segurança e CSP em modo `Report-Only`.
- **Python:**
  - lock com hashes (`requirements.lock` gerado com `--generate-hashes`);
  - o Dockerfile instala a partir do lock.
- **`Dockerfile.ai-agent` (C10):** `USER` não-root, imagem fixada por digest e `HEALTHCHECK`.
- **CI** em `.github/workflows/`:
  - lint e testes (jest e pytest);
  - `pnpm audit` e `pip-audit`;
  - gitleaks sobre o histórico.

## S4 — Contínuo: privacidade e governança

> **Status (22/09/2026): implementado na branch `feat/seguranca-s1`**, migration
> `20260922180000_add_user_security_events`. Decisões:
>
> - **Retenção:** job diário (4h, em lotes de 500) substitui `ai_messages.content` e
>   `ai_extracted_transactions.raw_input` por um marcador depois de
>   `AI_CONTENT_RETENTION_DAYS` (90; 0 desliga). **Apaga o texto e mantém a linha**: a
>   idempotência por `providerMessageId`, o encadeamento das conversas e as métricas de
>   volume continuam de pé. `raw_input` é obrigatório no schema, por isso recebe o marcador
>   em vez de `NULL`.
> - **Trilha de identidade:** nova `user_security_events` (append-only por trigger, como
>   `ops_audit_log`), gravada em troca de senha, troca de e-mail, verificação de telefone e
>   "encerrar todos os dispositivos", com ip e user agent. E-mails entram mascarados
>   (`j***@example.com`); nenhuma credencial em claro.
>   - O trigger recusa `UPDATE` e `TRUNCATE`, mas **permite `DELETE`**: a exclusão de conta
>     (LGPD) apaga em cascata a partir de `users`, e a aplicação não tem caminho que apague
>     essas linhas. O que o trigger impede é reescrever o passado para esconder uma tomada
>     de conta.
> - **Backups:** procedimento e o que sai do sistema documentados em
>   [docs/retencao-e-backups.md](../docs/retencao-e-backups.md). **O ensaio de restauração
>   continua pendente** — depende de acesso ao Railway.
> - **Medição da retenção:** a varredura filtra por `created_at`, sem índice próprio. No
>   volume atual é irrelevante (roda de madrugada); se passar a doer, o índice entra pelo
>   plano de performance, que é o dono dessa decisão (C6).

- Retenção de `AiMessage.content` e `AiExtractedTransaction.rawInput` (ex.: 90 dias) por job em lotes (C14).
- Documentar backups e testar restauração.
- Registrar mudanças de identidade (e-mail, telefone, senha) no log append-only.

## Quando a feature/melhorias for integrada

Itens do relatório que só existem na `feature/melhorias`. Aplicar ao integrar (C15):

- **Remoção de membro** (`members.service.ts`): além de trocar a senha, incrementar
  `sessionVersion`, revogar as sessões e revogar os contatos de WhatsApp do membro.
- **Aceite de convite:** `updateMany({ where: { id, status: 'pending' } })` e revalidação de assentos
  dentro da transação; teste de aceite concorrente com revogação.
- **Emissão de tokens duplicada** em `members.controller.ts` (e seu `COOKIE_OPTIONS`) passa a usar o `SessionService`.
- **Resolução de identidade de membro:** `findContactByPhone` passa a devolver `householdOwnerId`.
  A regra "só `verified`" continua valendo.
- **`/members/accept-invite`** entra na isenção de CSRF da mesma forma que login e cadastro
  (exigindo Origin permitido).
- **Endpoints internos `*/from-ai`** novos seguem a mesma chave interna por direção (S2).

## Critérios de aceite

**API (jest):**

- sessão revogada é rejeitada;
- refresh reutilizado revoga a família;
- troca de senha invalida todas as sessões;
- número pendente não resolve identidade;
- número antigo não resolve após a troca;
- duas reivindicações concorrentes têm um vencedor;
- preview e localhost são rejeitados em produção;
- cadastro não chama mais o envio da boas-vindas.

**Agente (pytest):**

- o boot falha sem segredo;
- webhook sem assinatura retorna 401;
- corpo acima do limite retorna 413;
- mídia grande é interrompida durante o streaming;
- confirmação pendente com `linkVersion` divergente é descartada;
- mensagem com o código, mesmo com o texto editado, verifica o número e responde com a boas-vindas.

**Web (manual, com dispositivos reais):**

- no smartphone, o botão abre o WhatsApp com a mensagem preenchida e o QR não aparece;
- no computador, o QR lido pelo celular verifica o número e a tela avança sozinha;
- no computador, o link abre o WhatsApp Desktop ou o WhatsApp Web;
- o cadastro não dispara mensagem para o número antes da verificação;
- código expirado mostra "gerar novo código" e o anterior deixa de valer.

## Rastreabilidade

| Item do relatório                           | Passo                                      |
| ------------------------------------------- | ------------------------------------------ |
| §1 Telefone declarado como verificado       | S1.1                                       |
| §2 Troca de telefone não revoga             | S1.2                                       |
| §3 Logout/senha não invalidam tokens        | S1.3 (membros: seção de integração)        |
| §4 Webhook sem assinatura por padrão        | S1.4                                       |
| §5 CORS/CSRF com previews/localhost         | S2                                         |
| §6 Portas publicadas                        | S1.5                                       |
| §7 Limites após alocação                    | S2                                         |
| §8 Sessão administrativa sem prazo absoluto | S2                                         |
| §9 Dependências                             | S3                                         |
| Mudança de identidade                       | S1.2                                       |
| Privacidade (`LogMessenger`)                | S1.4                                       |
| Retenção                                    | S4                                         |
| Headers do frontend                         | S3                                         |
| Container                                   | S3                                         |
| API interna                                 | S2                                         |
| Rate limiting                               | S2                                         |
| Convites                                    | Seção de integração (não existe na `main`) |
| Segredos                                    | S3                                         |

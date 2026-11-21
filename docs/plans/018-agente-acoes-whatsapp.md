# Plano: novas ações do agente de WhatsApp (resumo, baixa/fatura, corrigir/excluir)

## Contexto

Hoje o agente só **cria** lançamentos. Para consultas, correções, exclusões e baixas ele manda o usuário para o app ([message_processor.py:458-472](apps/ai-agent/src/services/message_processor.py#L458-L472)). O classificador já reconhece `query_summary`, `correct_last` e `cancel_last`, mas nenhuma delas executa nada. Outros dois problemas:

- "paguei a fatura do Nubank" hoje pode virar uma **despesa nova no cartão**, porque "fatura" está em `CARD_HINT_RE`.
- "paguei 120 de luz" cria uma despesa nova mesmo quando já existe a conta de luz em aberto, e isso duplica o gasto.

Do lado da API, quase tudo já existe atrás de JWT: resumo (`DashboardService.getSummary` / `getBusinessSummary`), baixa (`SettlementsService.settle`), pagamento de fatura (`CardPaymentsService.pay`), edição (`TransactionsService.update`), exclusão (`TransactionsService.remove`, e `InstallmentsService.remove` no parcelado) e busca (`TransactionsService.findAll`, com `search`, `settlement: 'open'`, `source` e período). O trabalho é **expor isso ao agente** por rotas internas e montar a conversa no agente.

**Decisões já tomadas com o Bruno:**

- **Alcance para corrigir e excluir:** "o último" ou uma busca nos últimos 30 dias. Com mais de um candidato, o agente mostra uma lista numerada.
- **Confirmação:** editar, excluir, dar baixa e pagar fatura **sempre** mostram o que vai acontecer e esperam um "sim".
- **Entrega:** em 3 fases, uma PR por fase, cada fase atrás de uma feature flag: resumo → baixa e fatura → corrigir e excluir.

As decisões estão registradas na [ADR 0024](../adrs/0024-agente-age-sobre-lancamentos-existentes.md) (confirmação obrigatória, alcance de 30 dias e rotas internas por `userId`).

---

## Base comum (entra na PR da Fase 1)

### API (`apps/api`)

- **Controller novo** `internal/controllers/internal-actions.controller.ts`, com `@UseGuards(InternalApiKeyGuard)`, `@SkipThrottle()` e `@ApiExcludeController()`, como em [internal.controller.ts](apps/api/src/internal/controllers/internal.controller.ts).
  - Todas as rotas ficam em `internal/users/:userId/...` e chamam `assertCanUseProduct` antes de tudo ([internal.service.ts:48](apps/api/src/internal/internal.service.ts#L48)).
  - A posse dos dados continua garantida pelos próprios serviços: `findOne(userId, id)`, `findOwned` etc.
- **Lógica nova:** fica num serviço novo, `internal/internal-actions.service.ts`, que só delega para os serviços existentes. Nenhuma regra financeira é reescrita.
- **Módulos:**
  - O `InternalModule` passa a importar `TransactionsModule` e `DashboardModule`.
  - Os dois passam a exportar o que o agente usa: `TransactionsService` e `InstallmentsService` no primeiro, `DashboardService` no segundo. `CardPaymentsService` sai em `CreditCardsModule.exports`.
- **Erros:** os 400/409 dos serviços já trazem mensagem em pt-BR para leigo (ex.: "Esta compra tem estornos…", fatura fechada). O agente **repassa o `message`** ao usuário em vez de dar um erro genérico.
- **Feature flags** (ADR 0023): `whatsapp_summary`, `whatsapp_payments` e `whatsapp_edit` no `FeatureKey` de `packages/shared` e no [feature-flags.catalog.ts](apps/api/src/feature-flags/feature-flags.catalog.ts), todas com `defaultEnabled: false`. **Cada flag entra na PR da sua fase**, para não existir flag sem efeito.
  - As rotas de cada fase recebem `@RequireFeature(...)`.
  - **Web:** `FEATURE_ROUTES` em [features.ts](apps/web/src/lib/features.ts) exige uma entrada por `FeatureKey`. Cada uma entra com lista vazia (`whatsapp_summary: []` etc.), porque elas não escondem nenhuma tela do app. O menu não é afetado: cada item cita a própria flag ([layout.tsx:94](apps/web/src/app/app/layout.tsx#L94)).

### Agente (`apps/ai-agent`)

- **`api_client`** ganha `patch` e `delete`, no mesmo molde de `get`/`post` ([api_client.py](apps/ai-agent/src/services/api_client.py)).
- **Schema** ([financial_intent.py](apps/ai-agent/src/schemas/financial_intent.py)): novos campos opcionais com default `None`, para continuar lendo estado pendente antigo.
  - `period_start` e `period_end` (ISO), resolvidos pelo LLM a partir de "esse mês", "mês passado", "outubro" ou "essa semana".
  - `target`: `TargetRef` com `last: bool`, `description`, `amount` e `date`, para apontar um lançamento existente.
  - `changes`: `TransactionChanges` com `amount`, `transaction_date`, `category_name`, `account_name` e `description`.
  - Novos `IntentType`: `settle_bill` e `pay_invoice`.
  - `correct_last` e `cancel_last` **mantêm os valores** (compatibilidade), mas passam a cobrir também a busca e não só "o último".
- **Estado de ação pendente** em `ConversationState` ([conversation_store.py](apps/ai-agent/src/services/conversation_store.py)): campo opcional `pending_action`, um dict com:
  - `kind`: `settle`, `pay_invoice`, `edit` ou `delete`;
  - `candidates`: lista de `{id, label, kind, cardId, remaining, purchaseId, recurrenceType}`;
  - `chosen` e `changes`.

  Reutilizar o que já existe: `awaiting_field` (com o novo valor `FIELD_CHOOSE` para "responda o número", além do `FIELD_CONFIRM`), `belongs_to`, `attempts` com `MAX_REPLY_ATTEMPTS`, `parsers.is_affirmative` / `is_negative` e o TTL de 30 minutos.

- **`services/action_processor.py`** (novo) concentra as ações, para o `message_processor` não crescer mais:
  - O `message_processor` só decide o caminho: com `pending_action` no estado, a resposta vai para `action_processor.handle_reply`; os novos intents vão para `action_processor.start(...)`.
  - O pendente de **criação** continua tendo prioridade, como hoje.
  - Um pedido novo no meio de uma pergunta descarta a pendência, como o `NEW_MESSAGE` já faz.
- **`services/target_resolver.py`** (novo) ordena os candidatos por:
  - nome (descrição ou categoria, com `reply_parsers.match_names`);
  - valor igual (tolerância de R$ 0,01);
  - proximidade da data.

  Mostra no máximo 5 opções numeradas ("1. Luz — R$ 120,00 — vence 20/11").

- **Resolução de conta e categoria:** tirar `_resolve_account` e `_resolve_category` de [transaction_creator.py](apps/ai-agent/src/services/transaction_creator.py) para funções públicas, reutilizadas na edição e na escolha da conta de onde saiu o dinheiro.
- **Idempotência:** o `jobId` da mensagem que trouxe o "sim" vira a `idempotencyKey` da baixa e do pagamento de fatura (os dois DTOs exigem chave; o `jobId` cabe em 8 a 100 caracteres). Um retry do job não paga duas vezes.
- **Prompt e regras:**
  - Atualizar `SYSTEM_PROMPT` em [openai_provider.py](apps/ai-agent/src/services/llm/openai_provider.py) com os novos intents e exemplos.
  - No fallback de regras ([intent_classifier.py](apps/ai-agent/src/services/intent_classifier.py)), "paguei a fatura" e "pagar fatura" viram `pay_invoice` antes do `CARD_HINT_RE`.
- **Flag desligada:** a rota devolve o erro de feature desligada e o agente responde o texto atual ("use o app"). Assim cada flag liga e desliga a fase inteira sem deploy.
- **Ajuda:** o `HELP_MESSAGE` e as boas-vindas ganham exemplos de cada fase quando ela entrar. O texto exibido segue a flag: a API passa as flags ativas no `findContactByPhone`, ou numa rota interna `GET internal/features`.

---

## Fase 1 — Resumo, saldo e "quanto gastei?" (só leitura)

**API:** `GET internal/users/:userId/summary?periodStart&periodEnd`

- Escolhe `getSummary` (pessoa física) ou `getBusinessSummary` (pessoa jurídica) pelo `profileType`.
- Devolve um **formato enxuto e estável**, montado num mapper na API, para o agente não depender do payload do dashboard:
  - `period`, `spent`, `received`, `toReceive`, `result`, `cashBalance`;
  - `byCategory`: as 8 maiores, com `{name, total}`;
  - `upcoming`: até 5 itens, com `{description, remaining, dueDate, isOverdue, kind}`;
  - `cardsDebt`.

**Agente:** `services/summary_service.py` formata a resposta conforme a pergunta:

| Pergunta                    | Resposta                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| "quanto gastei esse mês"    | Total gasto + 3 maiores categorias                                                         |
| "quanto gastei com mercado" | Só a categoria pedida (casada com `match_names` em `byCategory`); sem gasto nela, diz isso |
| "quanto recebi"             | Recebido + a receber                                                                       |
| "qual meu saldo"            | Saldo nas contas + o que vence até o fim do mês                                            |
| "resumo"                    | Gastos, recebido, resultado e as próximas 3 contas                                         |
| "o que tenho pra pagar"     | Lista de `upcoming`, com as vencidas primeiro                                              |

- Período padrão: mês corrente. Mês futuro mostra só o que já está agendado.
- **Rótulos para leigo** (memória "clareza para leigos"): "Gastos", "Recebido", "A receber", "A pagar", "Na fatura do cartão". Sem "realizado", "liquidação" ou "competência".
- Toda resposta termina com o link do app para os detalhes.

**Flag:** `whatsapp_summary`.

---

## Fase 2 — Dar baixa em conta em aberto e pagar fatura

**API:**

- `GET internal/users/:userId/open-items?type=expense|income`
  - Lançamentos em aberto via `findAll` com `settlement: 'open'`, vencidos e a vencer nos próximos 45 dias.
  - Faturas com saldo, reutilizando a montagem de `upcomingBills` ([dashboard.service.ts:211](apps/api/src/dashboard/dashboard.service.ts#L211)). Tornar esse método público, ou extraí-lo para uma função compartilhada.
- `POST internal/users/:userId/transactions/:id/settlements` → `SettlementsService.settle`. A data não pode ser futura (a API já valida).
- `POST internal/users/:userId/cards/:cardId/invoices/:invoiceId/payments` → `CardPaymentsService.pay`.

**Agente:**

- **`settle_bill`** ("paguei a luz", "marca o aluguel como pago", "recebi do cliente João"):
  1. Busca nos `open-items` do tipo certo.
  2. Pergunta: "Marcar como paga _Luz — R$ 120,00 (vence 20/11)_, saindo da conta Itaú, hoje? (sim/não)".
  3. Valores e datas:
     - Valor citado menor que o restante: baixa parcial, e a resposta diz quanto ainda falta.
     - Valor maior que o restante: só é aceito em lançamento fixo (a API trata como valor real); fora disso, o agente pergunta de novo.
     - Data: a dita na mensagem ou o dia da mensagem.
     - Conta: a citada; sem citação, a do próprio lançamento.
- **`pay_invoice`** ("paguei a fatura do Nubank", "paguei 500 da fatura"):
  - **Cartão:** o citado; se houver um só cartão, ele.
  - **Fatura:** a mais antiga com saldo, primeiro as vencidas.
  - **Valor:** o citado; sem valor, o restante da fatura.
  - **Conta de origem:** a citada; senão a conta comum preferencial; senão a única conta comum; com várias, pergunta com a lista.
  - Só pessoa física tem cartão (`assertIndividual`), então pessoa jurídica recebe uma resposta explicando isso.
- **Evitar duplicidade na criação.** Antes de criar uma **despesa ou receita em conta** (não no cartão), o agente procura um item em aberto que bata forte: mesma categoria ou descrição, mesmo valor e vencimento a até 7 dias. Se achar, pergunta: "Você tem _Luz — R$ 120,00_ em aberto, vence 20/11. É o pagamento dela? Responda _sim_ para marcar como paga ou _não_ para registrar um gasto novo."
  - O ponto de entrada é `message_processor.handle_intent`, antes de `transaction_creator.pending_question`.
  - Só acontece com a flag ligada.
- **Texto de sucesso:** trocar o "quando pagar, registre no app" de `_success_message` ([transaction_creator.py:237-242](apps/ai-agent/src/services/transaction_creator.py#L237-L242)) por "quando pagar, é só me avisar aqui".

**Flag:** `whatsapp_payments`.

---

## Fase 3 — Corrigir e excluir lançamento

**API:**

- `GET internal/users/:userId/transactions/search?q&last&limit`
  - Usa `findAll` com `periodStart` = hoje − 30 dias, o `search` e `limit` 20.
  - `last=true`: o último criado **pelo WhatsApp** (`source: 'whatsapp'`, ordenado por `createdAt desc`, limite 1).
  - Devolve `purchaseId`, `recurrenceType`, `type`, `account` e `category`.
- `PATCH internal/users/:userId/transactions/:id` → `TransactionsService.update`. Só aceita `amount`, `transactionDate`, `categoryId`, `accountId` e `description`; nada de `type` ou `status`.
- `DELETE internal/users/:userId/transactions/:id` → `TransactionsService.remove(userId, id, true)`, a mesma exclusão definitiva que o app usa ([TransactionsView.tsx:409](apps/web/src/components/transactions/TransactionsView.tsx#L409)).
- `DELETE internal/users/:userId/installments/:seriesId` → `InstallmentsService.remove`.

**Agente:**

- **Encontrar o lançamento:**
  - "apaga o último" / "corrige o último, foi 45": usa `last`.
  - "apaga o mercado de ontem": faz a busca e filtra no agente por valor e data quando ditos.
  - Mais de um candidato: lista numerada com `FIELD_CHOOSE`.
  - Nenhum: "Não encontrei esse lançamento nos últimos 30 dias. Para lançamentos mais antigos, use o app."
- **Editar:** mostra o antes e o depois ("_Mercado_ — R$ 50,00 → R$ 45,00, 17/11, Nubank. Confirma?") e, com o "sim", faz o `PATCH`. Categoria e conta passam pelos resolvedores públicos. Se a nova categoria for ambígua, pergunta antes da confirmação final.
- **Casos especiais:**
  - **Parcela:** excluir avisa "Isso exclui a compra inteira (3x de R$ 100,00)" e usa a rota de parcelamento. Editar o valor de uma parcela: a API recusa, e o agente repassa a mensagem.
  - **Ocorrência de lançamento fixo:** a edição ou exclusão vale só para aquela ocorrência. Mudar ou excluir a série inteira fica no app, e o agente diz isso.
  - **Transferência, pagamento de fatura e estorno:** "Esse tipo de lançamento só pode ser alterado no app".
  - **Erros 409** (fatura fechada, estornos): o agente repassa a mensagem da API.
- **Excluir duas vezes:** se o "sim" chega repetido e o lançamento já não existe (404), a resposta é "já tinha sido excluído". Não é tratado como erro.

**Flag:** `whatsapp_edit`.

---

## Arquivos principais

- **API:**
  - `apps/api/src/internal/controllers/internal-actions.controller.ts` (novo);
  - `apps/api/src/internal/internal-actions.service.ts` (novo), com o mapper do resumo;
  - `internal.module.ts`, `transactions.module.ts`, `dashboard.module.ts` e `credit-cards.module.ts` (imports e exports);
  - `dashboard.service.ts` (`upcomingBills` público);
  - `feature-flags.catalog.ts` e `packages/shared` (`FeatureKey`).
- **Web:** `apps/web/src/lib/features.ts` (as três chaves novas com lista vazia em `FEATURE_ROUTES`).
- **Agente:**
  - `schemas/financial_intent.py`, `services/conversation_store.py` e `conversation_manager.py`;
  - `services/message_processor.py` (só o desvio para as ações);
  - novos: `services/action_processor.py`, `target_resolver.py` e `summary_service.py`;
  - `services/transaction_creator.py` (resolvedores públicos e texto de sucesso), `services/api_client.py`;
  - `services/llm/openai_provider.py` (prompt) e `services/intent_classifier.py` (regras).
- **Docs:** `docs/plans/018-…`, `docs/adrs/0024-…`, `docs/005-whatsapp-messaging-runbook.md` (novos fluxos) e a tabela de fases no `CLAUDE.md`.

## Verificação (em cada fase)

- **Agente (`pytest -q`):**
  - Novos `test_summary_service.py`, `test_target_resolver.py` e `test_action_processor.py`.
  - Ampliar `test_conversation_flows.py`: pedido → lista → escolha → "sim" → execução; "não" cancela; duas respostas não entendidas desistem; pendência de outro dono é descartada; retry do job com o mesmo `jobId` não paga duas vezes.
  - Ampliar `test_openai_prompt.py` e `test_intent_classifier.py`: "paguei a fatura" vira `pay_invoice`; "quanto gastei com mercado" vira `query_summary` com categoria.
  - Estado antigo no Redis, sem os campos novos, continua sendo lido (`test_conversation_store.py`).
- **API:**
  - Specs de integração no banco `_validation` (memória "testes de integração": migrate precisa de `DIRECT_URL`).
  - Testar: dono errado devolve 404; sem assinatura devolve bloqueio; flag desligada devolve recusa; baixa idempotente pela chave; pagamento de fatura atualiza `remaining`; excluir parcela leva a compra inteira.
- **Ponta a ponta local:**
  - `pnpm dev` com messenger em modo log e `pnpm agent:worker`.
  - Ligar a flag em `/ops`.
  - Mandar mensagens pelo webhook simulado e seguir com `scripts/trace_message.py`.
  - Conferir no app que o número mudou junto: a conta saiu de "A pagar", a fatura baixou, o lançamento foi editado ou excluído.
- `pnpm lint`, e Prettier só nos arquivos alterados (memória).

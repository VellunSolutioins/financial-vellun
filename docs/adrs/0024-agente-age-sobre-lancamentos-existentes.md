# 0024 — Agente do WhatsApp consulta e age sobre lançamentos existentes

- **Status:** Aceito
- **Data:** 2026-11-21

## Contexto

Até aqui o agente só **criava** lançamentos. Resumo, saldo, correção, exclusão e baixa de
conta ou fatura mandavam o usuário para o app. As regras financeiras dessas ações já
existem na API (dashboard, liquidações, pagamento de fatura, edição e exclusão), mas só
atrás de JWT, para o app.

O plano completo, em três fases, está em
[docs/plans/018-agente-acoes-whatsapp.md](../plans/018-agente-acoes-whatsapp.md):

1. resumo, saldo e "quanto gastei?" (só leitura);
2. dar baixa em conta em aberto e pagar fatura;
3. corrigir e excluir lançamento.

## Decisão

- **Rotas internas por usuário, sem regra nova.** As ações ficam em
  `internal/users/:userId/...` (`InternalActionsController`), com a mesma chave interna do
  resto de `/internal`.
  - O `userId` vem do vínculo verificado do número (`GET /internal/whatsapp/contacts/:phone`).
  - Cada rota confere o direito de uso e **delega ao serviço que o app já usa**. A posse
    dos dados continua garantida por esses serviços.
- **Os números são os do app.** O resumo usa o mesmo cálculo do dashboard do perfil
  (`getSummary` para pessoa física, `getBusinessSummary` para jurídica). Um mapper na API
  (`internal/whatsapp-summary.ts`) entrega ao agente um formato enxuto e estável, que não
  muda quando as telas mudam.
- **Uma feature flag por fase** (ADR 0023), com `defaultEnabled: false`.
  - A rota recusa com `403 FEATURE_DISABLED`, e o agente responde o texto antigo ("veja
    no app").
  - A ajuda do agente lê `GET /internal/features` e só mostra as ações ligadas.
  - A flag de cada fase entra junto com a fase: `whatsapp_summary` (Fase 1),
    `whatsapp_payments` (Fase 2) e `whatsapp_edit` (Fase 3).
- **Toda ação que muda dados pede confirmação** (Fases 2 e 3): o agente mostra o que vai
  acontecer e só executa com um "sim". O `jobId` da mensagem do "sim" é a chave de
  idempotência, para um retry não pagar duas vezes.
- **Alcance de correção e exclusão** (Fase 3): "o último" lançamento criado pelo WhatsApp,
  ou uma busca nos últimos 30 dias. Com mais de um candidato, o agente mostra uma lista
  numerada.
- **Rótulos para leigo** (ADR 0020): "Gastos", "Recebido", "A pagar", "A receber",
  "Sobrou". No perfil empresarial, "Receitas" e "Despesas", como no dashboard.

## Consequências

- Cada fase entra desligada e é ligada no `/ops` depois de validada, sem deploy. Desligar
  volta ao comportamento anterior na mensagem seguinte.
- O agente passa a depender do formato de `internal/whatsapp-summary.ts`. Mudança nele é
  mudança de contrato entre os dois serviços.
- O dashboard empresarial só devolve as cinco maiores categorias. O contrato diz isso
  (`byCategoryComplete: false`), e o agente não afirma "não houve gasto" para uma categoria
  fora da lista.
- A consulta de resumo usa o LLM e conta no limite diário de mensagens, como qualquer
  outra mensagem.

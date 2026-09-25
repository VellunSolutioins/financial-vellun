# 0016 — Conta ou cartão preferencial para lançamentos

- **Status:** Aceito
- **Data:** 2026-09-25

## Contexto

O formulário de novo lançamento abria sem conta selecionada. Existia o
"cartão principal" (`credit_cards.is_primary`), mas ele só ordenava a lista de
Cartões, e só entre cartões — não dizia nada sobre contas, nem vinha
pré-selecionado em lugar nenhum.

## Decisão

- **Um preferencial por usuário, entre contas e cartões:**
  `users.preferred_account_id` (FK `accounts`, `ON DELETE SET NULL`). Guarda o
  `accountId` — no cartão, o da conta interna —, o mesmo valor que os seletores
  e os lançamentos usam. Uma coluna no usuário garante que só exista um, sem
  trava entre linhas.
- **Substitui o "cartão principal":** `is_primary` foi removida, e a rota
  `PATCH /credit-cards/:id/primary` também. A estrela passa a marcar o
  preferencial, nas telas de Contas e de Cartões. A migração **não** converte o
  principal antigo em preferencial: isso passaria a pré-selecionar um cartão que
  o usuário nunca escolheu para isso.
- **`PATCH /financial-resources/preferred`** com `{ accountId }`, `{ cardId }` ou
  `{}` (limpa). Só conta comum ativa ou cartão não arquivado do próprio usuário.
  O verbo é PATCH, e não PUT como no plano: o CORS da API só libera
  GET/POST/PATCH/DELETE, e nenhuma rota usa PUT.
- **Desativar a conta ou arquivar o cartão** preferencial zera a preferência. A
  leitura (`GET /financial-resources`) também ignora recurso inativo.
- **Formulário:** novo lançamento vem com o preferencial selecionado, sem
  sobrescrever uma escolha já feita. Em Receita, os cartões somem do seletor
  (cartão não recebe receita, ADR 0015) e um cartão preferencial não é aplicado.

## Consequências

- O agente do WhatsApp ainda usa "a primeira conta comum" como padrão; passar a
  usar o preferencial é a próxima etapa, e o dado já está no usuário.
- O teste que reexecuta o backfill da fase 1 remove a coluna `is_primary` do
  SQL antes de rodar; a migração da fase 1 não foi alterada.

# Conta casal (duo) — análise do problema

> Status: em discussão · 2026-11-15
>
> Objetivo: permitir que um usuário adicione outra pessoa (ex.: esposa) como **duo** da conta.
> Os dois WhatsApps passam a fazer lançamentos, e cada lançamento exibe o nome de quem o criou.

Dá pra fazer sem reescrever o projeto. A chave é **não** colocar dois números no mesmo usuário. A
esposa vira um usuário próprio, e esse usuário passa a operar os dados do seu usuário.

## Como o projeto funciona hoje

"Conta" e "usuário" são a mesma coisa. Uns 30 modelos do
[schema.prisma](../apps/api/prisma/schema.prisma) pertencem a um `userId`: contas, lançamentos,
cartões, faturas, categorias, assinatura etc. O WhatsApp entra assim:

- `WhatsappContact.userId` diz ao mesmo tempo **quem mandou** e **de quem são os dados**. Hoje as
  duas coisas são iguais, e é isso que o casal separa.
- Existe a regra de **um número por usuário**: ao verificar um número novo, `revokeContacts` revoga
  os outros ([whatsapp-link.service.ts:330](../apps/api/src/whatsapp-link/whatsapp-link.service.ts#L330)).
- O agente guarda tudo por **telefone**: lock, agrupamento de mensagens e conversa. Esse lado já
  está correto para dois números.
- Os services recebem `userId` como parâmetro e não leem a sessão por conta própria. É isso que
  torna a mudança barata.

## Três formas de fazer

|                                   | Como funciona                                                         | Custo | Problema                                                                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Dois números no mesmo User** | `WhatsappContact` ganha um apelido ("Ana")                            | Baixo | Quebra a regra de um número por usuário. A esposa não tem login: ou usa a sua senha, ou não entra no app. "Quem lançou" vira o nome de um contato, não de uma pessoa |
| **B. Membro** ✅                  | A esposa é um `User` próprio, ligado ao seu por uma tabela de vínculo | Médio | Precisa separar "dono dos dados" de "quem fez a ação" nas entradas da API                                                                                            |
| **C. "Household"**                | Nova entidade, e todo `userId` vira `householdId`                     | Alto  | Migrar 30 tabelas e umas 400 referências. Só se justifica se houver família com N pessoas, empresa com vários sócios etc.                                            |

**Recomendação: a B.** Ela mantém a verificação de WhatsApp e a regra de um número por usuário
exatamente como estão. Também já deixa o caminho pronto para a C: o "dono" funciona na prática como
o id do grupo.

## Como fica a B

**Modelo de dados**

- Tabela nova `AccountMember`, com: `ownerId`, `memberId`, `role` (owner/member), `status`
  (convidado/ativo/removido), `invitedAt`, `removedAt`. É modelada para N membros, com o "duo"
  limitado a 1 pela regra de negócio.
- `Transaction.createdById` (pode ser nulo, e nulo significa "o dono" nos dados antigos). Vale
  avaliar o mesmo campo em `InstallmentPurchase`, `TransactionSettlement` ("quem pagou"),
  `AccountTransfer` e `CardPayment`.
- Todas as colunas `userId` continuam como estão, significando **dono dos dados**. Não há migração
  nas tabelas existentes.

**API: dois ids por requisição**

- Um decorator/guard novo, por exemplo `@DataScope()`, devolve `{ ownerId, actorId, role }`. Para o
  dono, `ownerId` e `actorId` são iguais; para o membro, `ownerId` é o id do dono.
- Os controllers passam a enviar `ownerId` aos services onde hoje enviam `user.id`, e `actorId` onde
  importa saber quem criou. São cerca de 97 pontos com usuário da sessão, uma mudança mecânica.
- **Maior risco:** algum endpoint usar o `actorId` onde deveria ir o `ownerId`. Para o membro, isso
  mostraria uma tela vazia ou gravaria dados na conta errada. A defesa é uma bateria de testes de
  integração que chama os endpoints principais **como membro**.

**WhatsApp e agente**

- `findContactByPhone` ([internal.service.ts:64](../apps/api/src/internal/internal.service.ts#L64))
  passa a devolver `ownerId` além de `userId`. O agente grava os dados no `ownerId` e manda
  `createdById = userId`.
- O contrato muda (`schemaVersion` sobe), e o agente envia os dois ids.
- Confirmação pendente: o agente já descarta a confirmação se o `linkVersion` mudar. Basta
  incrementar o `linkVersion` do número do membro quando ele for **removido do duo**, e a
  confirmação velha morre sozinha.
- Comandos como "apaga o último" precisam ter significado claro: o último **de quem mandou**, não o
  último da conta.

**Assinatura**

- O direito de uso do membro vem do dono: `canUseProduct(ownerId)`. Isso inclui a isenção por
  número
  ([subscription-access.service.ts:76](../apps/api/src/billing/services/subscription-access.service.ts#L76)).
- O casal pode virar um plano próprio usando `Plan.features` ou uma feature flag (ADR 0023).

**Convite**

1. O dono informa nome, e-mail e celular do membro.
2. O membro recebe um link, cria a senha e entra.
3. O membro verifica o próprio WhatsApp pelo **mesmo fluxo de código que já existe**.

Não é preciso escrever nenhuma prova de posse nova.

**Web**

- Cada lançamento mostra quem o criou (inicial ou nome) e ganha um filtro "lançado por".
- Em "Minha Conta" entra uma seção "Duo" para convidar, ver o status e remover.
- O membro não vê cobrança e não pode excluir a conta.

## Decisões em aberto

1. **O membro precisa de login no app web**, ou só do WhatsApp? Se for só WhatsApp para sempre, a A
   basta. Mesmo assim, a sugestão é fazer a B com o login opcional (o membro só ativa o convite
   quando quiser).
2. **O membro pode ter finanças próprias separadas** além das compartilhadas? Sugestão: não na v1;
   um número lança em um único espaço. Isso também decide o que fazer se o membro já tiver conta com
   dados (sugestão: bloquear o convite).
3. **O duo vale só para pessoa física**, ou para empresa também?
4. **Ao remover o membro**, os lançamentos que ele criou continuam na conta do dono com o nome dele?
   Sugestão: sim, guardando uma cópia do nome.
5. **Notificações** (lembretes, fatura vencendo): vão para os dois números ou só para o dono?
6. **Cobrança**: duo é um plano pago à parte ou vem incluído?

## Próximos passos

Com as decisões acima respondidas: escrever o ADR 0024 e um plano de implementação em etapas —
schema e vínculo, depois o escopo na API com os testes de membro, depois agente e contrato, e por
fim web e convite. Os planos seguintes ficam em `docs/` numerados a partir deste (`018-…`, `019-…`).

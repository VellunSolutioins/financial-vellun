# 0008 — Estado de conversa distribuído e versionado

- **Status:** Aceito
- **Data:** 2026-09-05 (formato atualizado para v3 em 2026-09-27)

## Contexto

O `ConversationManager` guardava confirmações pendentes num `dict` de processo.
Com isso, o usuário podia receber "Confirma o lançamento?" e responder "sim"
para um worker que não sabia de nada — seja porque era outra instância, seja
porque houve deploy no meio do diálogo.

## Decisão

Trocar a implementação por um store distribuído, mantendo a API do
`ConversationManager` (`get` / `set_pending` / `clear`), que passa a ser
assíncrona:

- chave `conv:{phone}` no Redis;
- TTL configurável (`CONVERSATION_STATE_TTL_SECONDS`, 30 min por padrão);
- serialização **versionada** do `FinancialIntent`
  (`{"v": 1, "pendingIntent": …, "awaitingConfirmation": …, "lastMessageAt": …}`
  na primeira versão; ver [Evolução do formato](#evolução-do-formato));
- versão desconhecida, JSON corrompido ou intent incompatível são descartados
  com segurança, devolvendo estado vazio em vez de derrubar o processamento;
- `InMemoryConversationStore` preservado para testes e para
  `CONVERSATION_STATE_BACKEND=memory`.

**Atomicidade.** Cada operação é um único comando Redis (`GET`, `SET` com `EX`,
`DEL`) e portanto atômica. A sequência composta ler → decidir → gravar é
serializada pelo lock por telefone do consumer de processamento
([0004](0004-ordenacao-por-lock-por-telefone.md)) — não por otimismo.

### Evolução do formato

| Versão | Acrescentou                                                                  | Estados anteriores |
| ------ | ---------------------------------------------------------------------------- | ------------------ |
| v1     | `pendingIntent`, `awaitingConfirmation`, `lastMessageAt`                     | —                  |
| v2     | vínculo de quem recebeu a pergunta: `userId`, `contactId`, `linkVersion`     | v1 descartado      |
| v3     | `awaitingField`, `originalMessage`, `referenceDate`, `attempts` (2026-09-27) | v2 continua lido   |

- **v2** descarta o v1 porque, sem o vínculo, não há como saber se o número
  ainda pertence a quem recebeu a pergunta: a resposta poderia concluir o
  lançamento na conta de outra pessoa.
- **v3** registra **qual campo a pergunta espera** (`amount`, `type`, `date`,
  `account`, `category`, `installments`, `amount_basis`, `frequency`,
  `occurrences` ou `confirm`). A resposta é lida só para aquele campo — "10" é
  número de parcelas se a pergunta foi "Em quantas parcelas?" — em vez de passar
  pelas regras inteiras, que sobrescreviam campos que a resposta não trouxe (um
  "sim" trocava a data do lançamento pela de hoje). Guarda também a mensagem
  que abriu o lançamento (vira o `rawInput`), o dia em que ela chegou ("ontem"
  numa resposta é relativo a ele) e quantas respostas seguidas não responderam
  à pergunta (depois de duas, o pendente é descartado).
- O v3 **lê o v2**: sem `awaitingField`, a resposta é tratada como a
  confirmação genérica de antes. Assim um deploy não perde as perguntas em
  aberto. Os campos novos do `FinancialIntent` (conta, recorrência) têm valor
  padrão pelo mesmo motivo.

## Consequências

**Ganhos**

- A confirmação pendente sobrevive a restart e a deploy.
- Funciona com N instâncias: qualquer worker enxerga a pergunta em aberto.
- O TTL limpa diálogos abandonados sem varredura.
- Mudar o `FinancialIntent` não quebra o processamento: um estado que não
  valida mais é descartado e o usuário é reclassificado do zero; campos novos
  com valor padrão mantêm o estado antigo legível.

**Custos**

- Um `GET` e um `SET` no Redis por mensagem processada.
- Perder o Redis significa perder confirmações pendentes em aberto (o usuário
  precisaria repetir o lançamento). O `appendonly` do container reduz a janela.
- A API do `ConversationManager` virou assíncrona, o que exigiu ajustar os
  chamadores.

## Alternativas consideradas

- **Persistir em PostgreSQL.** Mais durável, mas adiciona escrita transacional
  no caminho quente de cada mensagem, e o estado é efêmero por natureza.
- **Reconstruir o estado a partir de `AiExtractedTransaction` com status
  `pending`.** Sem estado novo, mas exige consulta por telefone a cada mensagem
  e não expressa "aguardando resposta" com clareza.

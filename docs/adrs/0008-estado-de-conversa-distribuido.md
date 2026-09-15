# 0008 — Estado de conversa distribuído e versionado

- **Status:** Aceito
- **Data:** 2026-09-05

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
  (`{"v": 1, "pendingIntent": …, "awaitingConfirmation": …, "lastMessageAt": …}`);
- versão desconhecida, JSON corrompido ou intent incompatível são descartados
  com segurança, devolvendo estado vazio em vez de derrubar o processamento;
- `InMemoryConversationStore` preservado para testes e para
  `CONVERSATION_STATE_BACKEND=memory`.

**Atomicidade.** Cada operação é um único comando Redis (`GET`, `SET` com `EX`,
`DEL`) e portanto atômica. A sequência composta ler → decidir → gravar é
serializada pelo lock por telefone do consumer de processamento
([0004](0004-ordenacao-por-lock-por-telefone.md)) — não por otimismo.

## Consequências

**Ganhos**

- A confirmação pendente sobrevive a restart e a deploy.
- Funciona com N instâncias: qualquer worker enxerga a pergunta em aberto.
- O TTL limpa diálogos abandonados sem varredura.
- Mudar o `FinancialIntent` não quebra o processamento: o estado antigo é
  descartado e o usuário é reclassificado do zero.

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

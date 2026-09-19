# 0009 — Rollout por flag `MESSAGE_PIPELINE`

- **Status:** Aceito
- **Data:** 2026-09-05

## Contexto

A mudança troca todo o caminho de recepção e processamento de mensagens do
WhatsApp de uma vez: webhook, persistência, agrupamento, estado de conversa e
criação de lançamento. É o canal por onde o usuário registra dinheiro — uma
regressão aqui é perda ou duplicação de lançamento.

## Decisão

Manter os dois caminhos convivendo por uma release, selecionados por
`MESSAGE_PIPELINE`:

- `broker` (**padrão**) — webhook publica em fila, consumers processam;
- `legacy` — caminho antigo (`message_buffer` + `asyncio.create_task`).

O código antigo (`message_buffer.py`, `redis_buffer.py`) e seus testes
permanecem no repositório, intocados. O `lifespan` decide qual montar; o webhook
tem uma função `_handle_legacy` separada, e nada do caminho novo é importado
quando a flag está em `legacy`.

O padrão é `broker` porque o caminho novo já entra coberto por testes
automatizados (unitários e de integração com RabbitMQ e Redis reais) e é o que
resolve os problemas que motivaram a mudança. `legacy` existe para rollback em
minutos, por variável de ambiente, sem deploy de código.

## Consequências

**Ganhos**

- Rollback é uma variável de ambiente e um restart.
- O caminho antigo continua exercitado pelos testes existentes.

**Custos**

- Dois caminhos para manter até a remoção, e o risco de alguém corrigir só um.
- `transaction_creator` grava `source="whatsapp"` nos **dois** caminhos, então o
  modo legado não é byte a byte o comportamento anterior (que gravava `"ai"`).
  Foi uma mudança deliberada: o requisito pede `whatsapp` para lançamentos vindos
  desse fluxo.

## Pendência

Remover `message_buffer.py`, `redis_buffer.py`, `_handle_legacy` e a própria
flag depois que `broker` acumular tráfego real em produção. Enquanto isso não
acontece, `MESSAGE_BUFFER_BACKEND` e `MESSAGE_BUFFER_MAX_RETRIES` continuam
documentados como "somente para o modo legado".

## Alternativas consideradas

- **Corte direto, sem flag.** Menos código para manter, mas sem rede de
  segurança num canal que movimenta dinheiro.
- **Flag com padrão `legacy`.** Mais conservador, porém deixa o caminho novo
  sem tráfego real por mais tempo, adiando a descoberta de problemas.

-- A fila `whatsapp.outbound.v1` (P3 do plano de performance) tem DLQ própria, e
-- o catálogo de falhas precisa saber rotular de onde a mensagem veio. Sem este
-- valor, o consumer cairia no fallback `whatsapp_inbound` e o operador veria
-- falhas de **entrega** classificadas como falhas de **entrada** — o que muda o
-- destino do reprocessamento.
--
-- `ADD VALUE` só é possível porque o valor não é usado nesta mesma migration:
-- o Postgres não permite usar um rótulo de enum na transação que o criou.
ALTER TYPE "OpsFailureSource" ADD VALUE IF NOT EXISTS 'whatsapp_outbound';

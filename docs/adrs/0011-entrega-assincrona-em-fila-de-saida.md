# 0011 — Entrega da resposta em fila de saída

- **Status:** Aceito
- **Data:** 2026-09-22

## Contexto

O consumer de `whatsapp.processing.v1` chamava a Graph API **antes** do ack
(`processing_consumer._process`): calculava a resposta, enviava e só então
marcava o job como concluído.

Isso amarra duas coisas que falham por motivos diferentes e em escalas
diferentes:

- **processar** depende da nossa API, do Redis e da OpenAI, e tem efeitos que
  não se repetem com segurança — o lançamento é criado, a confirmação pendente
  é consumida;
- **entregar** depende da Meta, tem rate limit próprio e falha em bloco quando
  o WhatsApp cai.

Com o WhatsApp indisponível, cada job ficava preso no timeout do envio,
consumindo um slot de concorrência do processamento. O job não podia ser ackado
(a resposta não saiu), então o retry o reprocessava inteiro — e o
reprocessamento encontrava a confirmação pendente já consumida. O efeito
composto: uma queda da Meta virava backlog na fila de **processamento**,
degradando o registro de lançamentos que não tinha nada a ver com ela.

## Decisão

Uma fila própria para a saída: `whatsapp.outbound.v1`, com as mesmas filas de
retry por bucket e a mesma DLQ que as outras (`names.py`, `topology.py`,
`retry.py` não mudaram).

- **Contrato:** `OutboundMessageV1` em `messaging/contracts.py`, com
  `schemaVersion`, `phone`, `text`, `jobId`, `userId`, `contactId` e `kind`.
- **Ponto único de saída:** `services/outbound.py`. Todo texto que o agente
  responde passa por ele — resposta de job, número não vinculado, assinatura
  bloqueada, aviso de falha da DLQ. Nenhum ponto do domínio chama o messenger
  direto.
- **O entregador só entrega.** `OutboundMessageConsumer` recebe o telefone já
  resolvido e **não decide identidade** (contrato C5): reconsultá-la abriria a
  porta para entregar a um dono diferente do que o fluxo enxergou.
- **Classificação de falha** vem pronta do `WhatsappCloudApiMessenger`: `429` e
  `5xx` são `TransientError` (retry com backoff); demais `4xx` são
  `PermanentError` (DLQ direto — repetir não muda a resposta da Meta).
- **Deduplicação por `jobId`**: `job:sent:{jobId}` é gravado depois do envio e
  conferido antes. Cobre a reentrega do broker e uma republicação em
  duplicidade. Avisos sem `jobId` não deduplicam: repetir um aviso é bem menos
  grave que suprimir um legítimo por colisão de chave inventada.
- **Rollout por flag**, no padrão da [ADR-0009](0009-rollout-por-flag-message-pipeline.md):
  `OUTBOUND_DELIVERY=queue` (padrão) ou `direct` (entrega no caminho que
  calculou, como antes). A fila é **declarada sempre**, e o consumer dela roda
  mesmo em `direct`: no rollback, o que já está enfileirado precisa continuar
  saindo.

## Consequências

**O que melhora.** Uma queda da Meta deixa de contaminar o processamento: o job
é ackado assim que o estado está persistido, e o backlog se concentra numa fila
só — observável, drenável e reprocessável pelo painel de operações, que ganhou
`whatsapp_outbound` como origem. A concorrência de entrega
(`OUTBOUND_CONSUMER_CONCURRENCY`) passa a ser ajustável contra o rate limit da
Meta sem mexer na concorrência do processamento.

**O que piora.** Um salto a mais entre calcular e entregar: em condição normal,
alguns milissegundos de latência adicional por resposta. E um modo de falha
novo — mensagem parada na fila de saída com o processamento saudável —, que é
justamente o que a métrica `outbound_send_seconds` e a profundidade da fila
existem para tornar visível.

**Aviso de DLQ não realimenta a fila.** Uma falha vinda de
`whatsapp.outbound.dlq` **não** gera aviso ao usuário: o aviso é uma mensagem de
WhatsApp, entregue pela mesma fila que acabou de falhar; ele falharia igual,
cairia na DLQ e geraria outro aviso. O cooldown por telefone atrasaria o ciclo,
não o impediria. Quem precisa saber que a entrega parou é o operador.

**Não é entrega exatamente-uma-vez.** Entre "a Meta aceitou" e "o marcador foi
gravado" há uma janela em que um crash duplica a mensagem. Não existe
exatamente-uma-vez contra uma API externa; o que existe é estreitar a janela e
não fingir o contrário.

**`userId`/`contactId` podem vir vazios.** Numa retomada, a resposta sai de
`job:reply:{jobId}`, que guarda só o texto. Reconsultar a identidade para
preencher um campo de log seria uma chamada à API por entrega — e o entregador
não usa esses campos para nada.

## Alternativas consideradas

**Manter o envio no processamento e aumentar a concorrência.** Compra tempo e
não resolve: com a Meta fora, mais concorrência é mais slots presos no mesmo
timeout.

**Enviar depois do ack, no mesmo consumer.** Elimina o bloqueio do job, mas
perde a mensagem se o processo morrer entre o ack e o envio — e sem fila não há
retry, nem DLQ, nem backlog observável.

**Fila de saída por prioridade (resposta vs. aviso).** Útil se um dia os avisos
competirem com as respostas pelo rate limit da Meta. Hoje o volume não justifica
uma segunda fila; `kind` já está no contrato para quando justificar.

# 0007 — Áudio entra no agrupamento; imagem vira job próprio

- **Status:** Aceito
- **Data:** 2026-09-05

## Contexto

Antes, áudio e imagem pulavam o buffer e eram processados por
`asyncio.create_task` direto do webhook. Áudio era transcrito e classificado
como texto, ecoando a transcrição na resposta; imagem passava por visão, que
extrai um `FinancialIntent` estruturado, e **sempre** pedia confirmação.

Com o pipeline por fila, todo esse trabalho sai do request HTTP e vai para o
consumer de entrada. A pergunta é o que fazer com o resultado: mandar para o
agrupamento por telefone, como o texto, ou publicar um job próprio.

## Decisão

**Áudio entra no agrupamento.** A transcrição é texto e se combina naturalmente
com as mensagens em volta ("gastei" por texto + "47,50 no mercado" por áudio). O
eco da transcrição é preservado em `responsePrefix`, acumulado no job e
prefixado na resposta final.

**Imagem vira job próprio.** Um comprovante é autocontido. Passá-lo pelo
agrupamento significaria transformar o intent estruturado da visão em texto e
reclassificá-lo depois — perdendo precisão. Em vez disso, o consumer de entrada
publica um `ProcessingJobV1` direto em `whatsapp.processing.v1` com
`preExtractedIntent`, `forceConfirm=true` e `confirmQuestion`, e o consumer de
processamento pula a classificação.

Em ambos os casos, contato e assinatura são verificados **antes** de baixar,
transcrever ou aplicar visão, porque são operações pagas. A resolução de mídia
foi extraída para `src/services/media_resolver.py`, sem dependência de broker,
reaproveitada pelo consumer e pelo caminho legado.

## Consequências

**Ganhos**

- Nenhum download, STT ou visão acontece dentro do request HTTP.
- Comportamento preservado: áudio ecoa a transcrição, comprovante sempre pede
  confirmação.
- Um áudio seguido de um texto complementar continua sendo consolidado.

**Custos**

- `ProcessingJobV1` ganha quatro campos opcionais (`responsePrefix`,
  `preExtractedIntent`, `forceConfirm`, `confirmQuestion`) que só a mídia usa.
- Comprovante não passa pelo agrupamento: duas fotos seguidas viram dois jobs, e
  cada uma pede sua confirmação.
- A deduplicação por `providerMessageId` acontece **depois** da transcrição
  (mantendo a ordem original do código), então uma reentrega de áudio paga a
  transcrição de novo. Aceitável porque só ocorre em retry, que é raro.

## Alternativas consideradas

- **Tudo pelo agrupamento.** Mais fiel à literalidade do requisito, mas o
  comprovante perderia a extração estruturada da visão.
- **Tudo como job próprio, sem agrupar mídia.** Simples, mas quebra o caso do
  áudio complementado por texto.

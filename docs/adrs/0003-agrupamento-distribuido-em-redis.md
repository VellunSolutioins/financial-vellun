# 0003 — Agrupamento (debounce) distribuído em Redis

- **Status:** Aceito
- **Data:** 2026-09-05

## Contexto

No WhatsApp o usuário costuma quebrar uma instrução em várias mensagens curtas
("gastei" / "47,50" / "no mercado"). O comportamento existente agrupa por
telefone com debounce de 5 s, máximo de 10 mensagens e idade máxima de 30 s.

Esse agrupamento vivia em memória do processo (`message_buffer.py`), o que é
incompatível com múltiplos consumers: cada instância teria seu próprio buffer e
consolidaria pedaços diferentes da mesma frase.

O backend Redis alternativo que existia (`redis_buffer.py`) tinha um defeito: o
teto de idade era recalculado a partir de _agora_ a cada nova mensagem, e os
dois ramos do `if` eram idênticos. Na prática **a idade máxima nunca era
aplicada** — um fluxo contínuo de mensagens adiava o flush indefinidamente.

## Decisão

Agrupamento distribuído em Redis (`src/grouping/`), com as chaves:

| Chave                 | Papel                                               |
| --------------------- | --------------------------------------------------- |
| `group:{phone}`       | lista (RPUSH) das mensagens aguardando consolidação |
| `group:first:{phone}` | epoch da primeira mensagem do grupo                 |
| `group:due`           | sorted-set telefone → vencimento do debounce        |
| `group:lock:{phone}`  | lock distribuído durante a consolidação             |

O vencimento é `min(agora + debounce, primeira + idade_máxima)` — com a
**primeira** mensagem como referência, o que corrige o defeito acima.

O `GroupFlusherWorker` consolida nesta ordem, que é o ponto central da decisão:

1. adquire o lock do telefone;
2. **lê** o grupo sem apagar;
3. monta o `ProcessingJobV1`;
4. publica e aguarda o _publisher confirm_;
5. **só então** apaga o buffer e o agendamento;
6. libera o lock.

Se o processo cair entre 4 e 5, o grupo é republicado no próximo tick — mas com
o mesmo `jobId` determinístico ([0005](0005-idempotencia-em-tres-niveis.md)),
então o consumer descarta a duplicata.

Há uma implementação em memória com a mesma semântica (`InMemoryGroupStore`),
usada nos testes e quando `GROUP_STORE_BACKEND=memory`.

## Consequências

**Ganhos**

- O agrupamento funciona com N consumers; o lock garante que só um consolida
  cada telefone.
- Mensagens agrupadas sobrevivem a restart.
- A idade máxima passa a ser efetivamente respeitada.
- Ler-publicar-apagar prefere duplicar (que é tratado) a perder.

**Custos**

- Redis passa a ser dependência de produção.
- O flush é por polling (`WORKER_POLL_INTERVAL_SECONDS`, 1 s por padrão), então
  há até 1 s de atraso além do debounce.
- Ordem entre entradas depende do RPUSH, não de relógio — o que é o desejado,
  mas significa que a ordem reflete a chegada ao consumer, não ao provedor.

## Alternativas consideradas

- **Manter o buffer em memória e limitar a uma instância.** Rejeitada: impede
  escalar e perde tudo em cada deploy.
- **Agrupar dentro do próprio broker** (esperar N mensagens antes de consumir).
  RabbitMQ não oferece agregação por chave; seria reimplementar o mesmo estado.
- **Sem agrupamento, uma mensagem por lançamento.** Rejeitada: quebraria o
  comportamento atual e degradaria a extração de intenção.

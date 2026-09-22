# Configuração declarativa dos serviços no Railway

Um arquivo por serviço. O Railway não lê esta pasta sozinho: em cada serviço,
**Settings → Config as code → Railway config file**, aponte para o caminho
correspondente. Sem isso, os arquivos aqui são só documentação.

| Serviço no Railway                       | Arquivo                      | Papel                                   |
| ---------------------------------------- | ---------------------------- | --------------------------------------- |
| `financial-vellun-api`                   | `api.toml`                   | NestJS + Prisma                         |
| `financial-vellun-web`                   | `web.toml`                   | Next.js (enquanto não está na Vercel)   |
| `financial-vellun-ai-agent`              | `ai-agent.toml`              | Webhook do WhatsApp (HTTP)              |
| `financial-vellun-ai-agent-worker`       | `ai-agent-worker.toml`       | Consumers das filas                     |
| `alloy`                                  | —                            | Ver `docs/observability.md`             |
| `rabbitmq`, `postgres`, `redis`          | —                            | Plugins/imagens do próprio Railway      |

O nome do serviço importa: ele vira o endereço na rede privada
(`<serviço>.railway.internal`) e é o que o `config.alloy` scrapa. Renomear um
serviço quebra o scrape em silêncio — o alvo fica `up == 0` e ninguém é
notificado, porque "sem dado" não é "com erro".

## Separar HTTP e worker

As duas metades da mesma decisão:

1. no `financial-vellun-ai-agent`, `RUN_CONSUMERS_IN_API=false`;
2. um serviço novo `financial-vellun-ai-agent-worker`, **mesma imagem**
   (`Dockerfile.ai-agent`), comando `python -m src.worker`, `WORKER_METRICS_PORT=8011`,
   **sem domínio público**.

Fazer só (1) para o processamento inteiro. Fazer só (2) roda tudo duas vezes —
não duplica lançamento (o `jobId` é idempotente), mas dobra o custo de IA e as
conexões com o Postgres.

Depois de subir o worker, descomente o alvo dele em
`infra/observability/alloy/config.alloy`.

## Checklist de rede privada (contrato C10)

Nada além do que precisa ser público é público.

| Serviço                | Domínio público | Por quê                                                                 |
| ---------------------- | --------------- | ----------------------------------------------------------------------- |
| `web`                  | **sim**         | é o produto                                                             |
| `api`                  | **sim**         | o browser chama direto                                                  |
| `ai-agent`             | **sim**         | a Meta entrega o webhook nele (assinado, `X-Hub-Signature-256`)          |
| `ai-agent-worker`      | não             | só consome fila; a 8011 é health e metrics                              |
| `alloy`                | não             | recebe log e scrapa pela rede privada                                   |
| `postgres`, `redis`, `rabbitmq` | não    | nunca expostos; acesso só por `*.railway.internal`                      |

Conferir a cada serviço novo:

- as URLs entre serviços usam `*.railway.internal`, não o domínio público — o
  tráfego interno saindo e voltando pela internet paga latência e egress, e
  passa pelo rate limit por IP como se fosse usuário;
- `MAIN_API_URL` do agente aponta para `http://financial-vellun-api.railway.internal:3001`;
- `LOKI_PUSH_URL` aponta para `http://alloy.railway.internal:3100`;
- a rede privada do Railway é **IPv6**: quem serve HTTP precisa escutar em `::`,
  não em `0.0.0.0` (ver `docs/observability.md`);
- `PORT` fixo onde o Alloy scrapa (3001 na API, 8010 no agente, 8011 no worker);
  se o Railway atribuir outra porta, o alvo fica `down` em silêncio.

## `overlapSeconds` e o drain

`overlapSeconds` mantém o container antigo vivo enquanto o novo sobe. Nos
serviços que consomem fila ele precisa ser **maior que `SHUTDOWN_DRAIN_SECONDS`**
(20s): o worker antigo para de receber, termina o que está em voo e devolve o
resto com `nack requeue`. Se o SIGKILL chegar antes do fim do drain, nada se
perde — nenhuma mensagem é ackada antes de concluir —, mas o que estava em voo
só volta pelo timeout de redelivery do broker, o que é mais lento e aparece como
latência fim a fim.

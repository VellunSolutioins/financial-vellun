# Connection budget do PostgreSQL

Quem pode abrir quantas conexões, e por quê. O `max_connections` é um recurso
global e silencioso: ninguém percebe que está no limite até um deploy falhar
inteiro com `FATAL: sorry, too many clients already` — e o deploy é justamente
quando duas versões do mesmo serviço coexistem.

Referência: P2 do [plano de performance](../plan/plano-implementacao-performance.md).

## Quem fala com o Postgres

Uma constatação que simplifica tudo: **só a API fala com o banco**. O agente de
IA — webhook e worker — não tem driver de Postgres; tudo que ele precisa passa
pelas rotas `/internal` da API. Escalar o worker por backlog de fila, portanto,
**não** consome conexão de banco diretamente; consome throughput da API, que é
quem tem o pool.

| Consumidor                       | Conexões                         | Observação                                          |
| -------------------------------- | -------------------------------- | --------------------------------------------------- |
| API (`financial-vellun-api`)     | `réplicas × connection_limit`    | é o único pool de aplicação                         |
| `prisma migrate deploy` no start | 1, por `DIRECT_URL`              | curta; some quando a migration termina              |
| `postgres_exporter` (Alloy)      | 1–2                              | usuário `vellun_monitor`, só leitura de estatística |
| Operação manual (psql, Studio)   | 1–3                              | imprevisível; é por isso que existe folga           |
| Reserva do próprio Postgres      | `superuser_reserved_connections` | 3 por padrão; não é seu para gastar                 |

## A conta

```
max_connections ≥ (réplicas_api × connection_limit)
                + 1   (migration no start)
                + 2   (exporter)
                + 3   (operação manual)
                + superuser_reserved_connections
                + folga para o deploy (a instância antiga ainda não morreu)
```

O termo do deploy é o que costuma ser esquecido: com `overlapSeconds`, durante
alguns segundos existem **duas** instâncias da API, cada uma com o pool cheio.
Na prática, dimensione para `2 × réplicas` durante a janela de deploy.

### Padrão atual (1 réplica, `max_connections = 100`)

| Item                    | Conexões |
| ----------------------- | -------: |
| API, 1 réplica × 5      |        5 |
| Sobreposição no deploy  |       +5 |
| Migration               |       +1 |
| Exporter                |       +2 |
| Operação manual         |       +3 |
| Reserva do superusuário |       +3 |
| **Pico**                |   **19** |

Folga larga de propósito: o custo de uma conexão ociosa é memória; o custo de
faltar uma é o deploy não subir.

## Como configurar

Na `DATABASE_URL` da API (o Prisma lê estes parâmetros da própria URL):

```
postgresql://.../financial_vellun?connection_limit=5&pool_timeout=10
```

- **`connection_limit`** — tamanho do pool do Prisma **por processo**. Sem ele,
  o padrão é `núcleos × 2 + 1`, que varia com a máquina que o Railway der: o
  mesmo código passa a abrir número diferente de conexões entre deploys, e a
  conta acima deixa de valer.
- **`pool_timeout`** — segundos esperando uma conexão livre antes de falhar.
  Sem teto, uma consulta lenta vira fila e a requisição fica pendurada; com
  teto, ela falha rápido e o erro aponta para o lugar certo.

Atrás de um pooler em _transaction mode_, acrescente `pgbouncer=true`:

```
postgresql://.../financial_vellun?pgbouncer=true&connection_limit=5&pool_timeout=10
```

`pgbouncer=true` desliga os prepared statements nomeados do Prisma, que em
transaction mode vazariam entre sessões diferentes.

**`DIRECT_URL` nunca passa pelo pooler** (contrato C7): `prisma migrate deploy`
usa advisory lock e prepared statements nomeados, e depende de manter a mesma
sessão entre comandos.

## O que o pooler muda para o código

Com PgBouncer em transaction mode, uma "sessão" só existe dentro de uma
transação. O que continua funcionando e o que não:

| Recurso                                      | Transaction mode              |
| -------------------------------------------- | ----------------------------- |
| `prisma.$transaction(async (tx) => ...)`     | ✅ sim                        |
| `SELECT ... FOR UPDATE` dentro da transação  | ✅ sim                        |
| `updateMany` condicional                     | ✅ sim                        |
| Advisory lock de **sessão**                  | ❌ não                        |
| `LISTEN` / `NOTIFY`                          | ❌ não                        |
| Prepared statement nomeado fora de transação | ❌ não (daí `pgbouncer=true`) |

As operações atômicas do plano de segurança (rotação de refresh token,
verificação de posse do telefone, conversa ativa do contato) usam transação
interativa e `updateMany` condicional — todas da metade de cima da tabela.
Nenhuma usa advisory lock de sessão nem `LISTEN`.

## Testar o pooler localmente

O PgBouncer está no compose como perfil opcional, para que `pnpm db:up` continue
subindo só o essencial:

```bash
docker compose -f infra/docker/docker-compose.yml --profile pooler up -d pgbouncer
```

Depois, na `apps/api/.env`, aponte só a `DATABASE_URL` para a porta `6432`
(`DIRECT_URL` continua na `5432`) e rode a API. Se algo depender de sessão, é
aqui que aparece — não em produção.

## Monitorar

O exporter já expõe o que interessa; o alerta útil é sobre a **proporção**, não
sobre o número absoluto:

```promql
sum(pg_stat_activity_count) / on() pg_settings_max_connections > 0.8
```

Ver também `pg_stat_activity` por `state`: muitas conexões em `idle in
transaction` indicam transação aberta sem necessidade — o que esgota o pool sem
nenhuma carga real.

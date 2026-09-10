-- Usuário de monitoramento do Postgres: SOMENTE LEITURA de estatísticas.
--
-- O postgres_exporter não deve usar a credencial da aplicação. Ele não precisa
-- ler nenhuma tabela de negócio, e muito menos escrever — e um exporter é um
-- processo exposto a mais um serviço na rede. Privilégio mínimo aqui é baixo
-- custo e alto retorno.
--
-- Aplicar (uma vez, como superusuário):
--   psql "$DATABASE_URL" -f infra/observability/alloy/postgres-monitoring-user.sql
--
-- Em desenvolvimento a senha abaixo é a que o compose de observabilidade espera.
-- Em produção, gere uma senha própria e ajuste POSTGRES_EXPORTER_DSN nas
-- variáveis do Railway — nunca aqui.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vellun_monitor') THEN
    CREATE ROLE vellun_monitor WITH LOGIN PASSWORD 'vellun_monitor_dev';
  END IF;
END
$$;

-- `pg_monitor` é o papel predefinido do Postgres exatamente para isto: dá acesso
-- às visões `pg_stat_*` (inclusive as colunas que normalmente só o dono vê) sem
-- conceder leitura de dado nenhum. É o que substitui o antigo truque de
-- funções `SECURITY DEFINER` uma a uma.
GRANT pg_monitor TO vellun_monitor;

-- Conectar ao banco é necessário para o exporter abrir sessão; `CONNECT` não dá
-- acesso a tabela alguma por si.
GRANT CONNECT ON DATABASE financial_vellun TO vellun_monitor;

-- Sem `USAGE` no schema, nem as visões de sistema em `public` são alcançáveis.
-- Note que NÃO há `GRANT SELECT ON ALL TABLES`: o exporter não lê dado de
-- negócio, e conceder isso é o erro comum desta configuração.
GRANT USAGE ON SCHEMA public TO vellun_monitor;

-- Limita o estrago de um exporter em loop: no máximo 5 conexões simultâneas.
ALTER ROLE vellun_monitor CONNECTION LIMIT 5;

-- Conferir o que o papel de fato pode fazer:
--   \du vellun_monitor
--   SET ROLE vellun_monitor; SELECT count(*) FROM pg_stat_activity;  -- deve funcionar
--   SET ROLE vellun_monitor; SELECT count(*) FROM users;             -- deve FALHAR

-- CreateTable
CREATE TABLE "user_security_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_security_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_security_events_user_id_created_at_idx" ON "user_security_events"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "user_security_events" ADD CONSTRAINT "user_security_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Trilha imutável: a linha gravada não muda mais.
--
-- O trigger recusa UPDATE e TRUNCATE, e vale para qualquer papel — inclusive o
-- dono da tabela, que devolveria a si mesmo qualquer privilégio revogado.
--
-- DELETE fica permitido de propósito: é o que a exclusão de conta (LGPD)
-- precisa, via cascata a partir de `users`. A aplicação não tem caminho de
-- código que apague estas linhas, e quem tem acesso direto ao banco já está
-- além do que um trigger protege. O que o trigger impede é o caso real:
-- reescrever o passado para esconder uma tomada de conta.
CREATE OR REPLACE FUNCTION user_security_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'user_security_events e append-only: % nao e permitido', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_security_events_no_update
  BEFORE UPDATE ON "user_security_events"
  FOR EACH ROW EXECUTE FUNCTION user_security_events_append_only();

-- `TRUNCATE` não passa por trigger de linha; precisa do seu próprio.
CREATE TRIGGER user_security_events_no_truncate
  BEFORE TRUNCATE ON "user_security_events"
  FOR EACH STATEMENT EXECUTE FUNCTION user_security_events_append_only();

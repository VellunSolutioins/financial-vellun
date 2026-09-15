-- CreateEnum
CREATE TYPE "OpsRole" AS ENUM ('viewer', 'operator', 'ops_admin');

-- CreateEnum
CREATE TYPE "OpsAuditResult" AS ENUM ('success', 'failure', 'denied');

-- CreateTable
CREATE TABLE "ops_operators" (
    "id" TEXT NOT NULL,
    "github_login" TEXT NOT NULL,
    "github_user_id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "role" "OpsRole" NOT NULL DEFAULT 'viewer',
    "can_view_sensitive" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "ops_operators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_audit_log" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "reason" TEXT,
    "result" "OpsAuditResult" NOT NULL,
    "operation_id" TEXT NOT NULL,
    "before_state" JSONB,
    "after_state" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ops_operators_github_login_key" ON "ops_operators"("github_login");

-- CreateIndex
CREATE UNIQUE INDEX "ops_operators_github_user_id_key" ON "ops_operators"("github_user_id");

-- CreateIndex
CREATE INDEX "ops_audit_log_created_at_idx" ON "ops_audit_log"("created_at");

-- CreateIndex
CREATE INDEX "ops_audit_log_operator_id_created_at_idx" ON "ops_audit_log"("operator_id", "created_at");

-- CreateIndex
CREATE INDEX "ops_audit_log_operation_id_idx" ON "ops_audit_log"("operation_id");

-- CreateIndex
CREATE INDEX "ops_audit_log_target_type_target_id_idx" ON "ops_audit_log"("target_type", "target_id");

-- AddForeignKey
ALTER TABLE "ops_audit_log" ADD CONSTRAINT "ops_audit_log_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "ops_operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Append-only imposto pelo banco ──────────────────────────────────────────
-- Uma trilha de auditoria que a aplicação consegue reescrever não é trilha de
-- auditoria. Não basta "o service não chama update": basta um bug, um
-- `prisma studio` aberto ou um script de manutenção para a garantia cair.
--
-- A trava é um trigger, e não apenas um `REVOKE UPDATE, DELETE`, porque em
-- desenvolvimento a aplicação conecta como **dona** da tabela — e o dono pode
-- devolver a si mesmo qualquer privilégio revogado. O trigger vale para
-- qualquer papel (só um superusuário desabilitando-o explicitamente passa por
-- cima, o que é auditável no próprio banco). O usuário de monitoramento
-- somente-leitura provisionado na infraestrutura é complementar, não substituto.
CREATE OR REPLACE FUNCTION ops_audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ops_audit_log e append-only: % nao e permitido', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ops_audit_log_no_update_or_delete
  BEFORE UPDATE OR DELETE ON "ops_audit_log"
  FOR EACH ROW EXECUTE FUNCTION ops_audit_log_append_only();

-- `TRUNCATE` não passa por trigger de linha; precisa do seu próprio.
CREATE TRIGGER ops_audit_log_no_truncate
  BEFORE TRUNCATE ON "ops_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION ops_audit_log_append_only();

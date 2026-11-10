-- Feature flags globais do app, controladas pelo painel de operações.
--
-- A tabela guarda só o estado; quais flags existem e o default de cada uma vêm
-- do catálogo no código (`FEATURE_CATALOG`). Por isso nenhuma linha é inserida
-- aqui: sem linha, vale o default, e Agenda/Anotações continuam ligadas.

-- CreateTable
CREATE TABLE "feature_flags" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_operator_id" TEXT,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);

-- AddForeignKey
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_updated_by_operator_id_fkey" FOREIGN KEY ("updated_by_operator_id") REFERENCES "ops_operators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

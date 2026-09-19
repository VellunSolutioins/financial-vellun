-- Marca-d'água do gerador de ocorrências recorrentes.
-- O backfill varre uma janela para trás para se recuperar de um cron perdido;
-- sem esta coluna a idempotência dependia só do índice único
-- (recurring_rule_id, competence_month), que desaparece quando o usuário exclui
-- o lançamento de vez (hard delete) — e a varredura o recriava na noite seguinte.
ALTER TABLE "recurring_rules" ADD COLUMN "last_generated_at" DATE;

-- Regras já existentes: assume tudo até hoje como varrido, para que o primeiro
-- cron após o deploy não ressuscite lançamentos apagados no passado.
UPDATE "recurring_rules" SET "last_generated_at" = CURRENT_DATE;

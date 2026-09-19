-- CreateEnum
CREATE TYPE "MemberInviteStatus" AS ENUM ('pending', 'accepted', 'revoked', 'expired');

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "max_members" INTEGER NOT NULL DEFAULT 1;

-- AlterTable (nullable first — backfilled below before becoming NOT NULL)
ALTER TABLE "transactions" ADD COLUMN     "created_by_user_id" TEXT;

-- Backfill: quem criou lançamentos existentes é o próprio dono da conta.
UPDATE "transactions" SET "created_by_user_id" = "user_id" WHERE "created_by_user_id" IS NULL;

ALTER TABLE "transactions" ALTER COLUMN "created_by_user_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "household_owner_id" TEXT;

-- CreateTable
CREATE TABLE "member_invites" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "MemberInviteStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),

    CONSTRAINT "member_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "member_invites_token_key" ON "member_invites"("token");

-- CreateIndex
CREATE INDEX "member_invites_owner_id_idx" ON "member_invites"("owner_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_household_owner_id_fkey" FOREIGN KEY ("household_owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_invites" ADD CONSTRAINT "member_invites_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

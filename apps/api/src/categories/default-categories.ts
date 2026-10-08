import { Db } from '../common/db';

/**
 * Categoria padrão (perfil pessoal) dos lançamentos de pagamento de fatura.
 * O mesmo nome está em `prisma/seed.ts` e na migration que a cria.
 */
export const CARD_INVOICE_CATEGORY = 'Fatura do cartão';

/** Id da categoria padrão "Fatura do cartão"; nulo se ela ainda não existe no banco. */
export async function findCardInvoiceCategoryId(db: Db): Promise<string | null> {
  const category = await db.category.findFirst({
    where: {
      userId: null,
      isDefault: true,
      profileType: 'individual',
      type: 'expense',
      name: CARD_INVOICE_CATEGORY,
    },
    select: { id: true },
  });
  return category?.id ?? null;
}

// `\p{M}`: as marcas de acento que o NFKD separa da letra.
const sameName = (name: string) =>
  name.normalize('NFKD').replace(/\p{M}/gu, '').trim().toLowerCase();

/**
 * Tira da lista a categoria padrão que o usuário já tem como dele (mesmo nome,
 * sem acento nem caixa, e mesmo tipo). Uma categoria padrão nova não pode
 * aparecer duplicada para quem já tinha criado "Streaming" ou "Delivery".
 */
export function withoutShadowedDefaults<
  C extends { name: string; type: string; isDefault: boolean; userId: string | null },
>(categories: readonly C[]): C[] {
  const own = new Set(
    categories.filter((c) => c.userId !== null).map((c) => `${c.type}:${sameName(c.name)}`),
  );
  return categories.filter(
    (c) => !(c.isDefault && c.userId === null && own.has(`${c.type}:${sameName(c.name)}`)),
  );
}

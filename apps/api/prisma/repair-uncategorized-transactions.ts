import { PrismaClient, ProfileType, TransactionType } from '@prisma/client';

const prisma = new PrismaClient();

const CATEGORY_KEYWORDS: Record<string, string> = {
  mercado: 'Mercado',
  supermercado: 'Mercado',
  feira: 'Mercado',
  padaria: 'Alimentação',
  almoço: 'Alimentação',
  almoco: 'Alimentação',
  jantar: 'Alimentação',
  lanche: 'Alimentação',
  restaurante: 'Alimentação',
  comida: 'Alimentação',
  café: 'Alimentação',
  cafe: 'Alimentação',
  uber: 'Transporte',
  ônibus: 'Transporte',
  onibus: 'Transporte',
  gasolina: 'Transporte',
  combustível: 'Transporte',
  combustivel: 'Transporte',
  transporte: 'Transporte',
  condomínio: 'Moradia',
  condominio: 'Moradia',
  aluguel: 'Moradia',
  luz: 'Moradia',
  água: 'Moradia',
  agua: 'Moradia',
  internet: 'Moradia',
  médico: 'Saúde',
  medico: 'Saúde',
  farmácia: 'Saúde',
  farmacia: 'Saúde',
  remédio: 'Saúde',
  remedio: 'Saúde',
  faculdade: 'Educação',
  escola: 'Educação',
  curso: 'Educação',
  livro: 'Educação',
  cinema: 'Lazer',
  viagem: 'Lazer',
  show: 'Lazer',
  bar: 'Lazer',
  salário: 'Salário',
  salario: 'Salário',
  investimento: 'Investimentos',
  dividendo: 'Investimentos',
  marketing: 'Marketing',
  software: 'Software',
  imposto: 'Impostos',
  fornecedor: 'Fornecedores',
  venda: 'Vendas',
};

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function payloadCategoryName(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as Record<string, unknown>;
  const value = data.category_name ?? data.categoryName ?? data.category;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function inferCategoryName(description: string, type: TransactionType): string | null {
  const text = normalize(description);
  for (const [keyword, categoryName] of Object.entries(CATEGORY_KEYWORDS)) {
    if (text.includes(normalize(keyword))) return categoryName;
  }

  if (type === TransactionType.income) {
    return null;
  }
  return null;
}

async function categoriesByUser(userId: string, profileType: ProfileType) {
  const categories = await prisma.category.findMany({
    where: {
      profileType,
      OR: [{ userId }, { userId: null, isDefault: true }],
    },
    orderBy: [{ userId: 'desc' }, { isDefault: 'desc' }, { name: 'asc' }],
  });

  const byName = new Map<string, (typeof categories)[number]>();
  for (const category of categories) {
    const key = normalize(category.name);
    if (!byName.has(key)) byName.set(key, category);
  }
  return byName;
}

async function main() {
  const apply = process.env.APPLY_REPAIR === 'true' || process.argv.includes('--apply');
  const transactions = await prisma.transaction.findMany({
    where: {
      categoryId: null,
      type: { in: [TransactionType.expense, TransactionType.income] },
    },
    include: {
      user: { select: { id: true, email: true, profileType: true } },
      aiExtractedTransactions: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
    orderBy: { transactionDate: 'asc' },
  });

  const categoryCache = new Map<string, Awaited<ReturnType<typeof categoriesByUser>>>();
  let repaired = 0;
  let skipped = 0;

  console.log(
    `Encontrados ${transactions.length} lançamentos sem categoria. Modo: ${apply ? 'APLICAR' : 'SIMULAR'}.`,
  );

  for (const transaction of transactions) {
    const cacheKey = `${transaction.user.id}:${transaction.user.profileType}`;
    let byName = categoryCache.get(cacheKey);
    if (!byName) {
      byName = await categoriesByUser(transaction.user.id, transaction.user.profileType);
      categoryCache.set(cacheKey, byName);
    }

    const extractedCategoryName =
      transaction.aiExtractedTransactions
        .map((audit) => payloadCategoryName(audit.extractedPayload))
        .find(Boolean) ?? null;
    const inferredCategoryName =
      extractedCategoryName ?? inferCategoryName(transaction.description, transaction.type);
    const category = inferredCategoryName ? byName.get(normalize(inferredCategoryName)) : null;

    if (!category) {
      skipped += 1;
      console.log(
        `[skip] ${transaction.transactionDate.toISOString().slice(0, 10)} | ${transaction.user.email} | ${transaction.description}`,
      );
      continue;
    }

    repaired += 1;
    console.log(
      `[${apply ? 'update' : 'would update'}] ${transaction.description} -> ${category.name}`,
    );

    if (apply) {
      await prisma.transaction.update({
        where: { id: transaction.id },
        data: { categoryId: category.id },
      });
    }
  }

  console.log(`Reparáveis: ${repaired}. Sem correspondência segura: ${skipped}.`);
  if (!apply) {
    console.log('Nenhuma alteração aplicada. Rode novamente com --apply para atualizar o banco.');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });


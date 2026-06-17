import { PrismaClient, ProfileType, TransactionType } from '@prisma/client';

const prisma = new PrismaClient();

const individualCategories = [
  { name: 'Alimentação', type: TransactionType.expense, color: '#FF6B6B', profileType: ProfileType.individual },
  { name: 'Mercado', type: TransactionType.expense, color: '#FFA07A', profileType: ProfileType.individual },
  { name: 'Moradia', type: TransactionType.expense, color: '#87CEEB', profileType: ProfileType.individual },
  { name: 'Transporte', type: TransactionType.expense, color: '#98FB98', profileType: ProfileType.individual },
  { name: 'Saúde', type: TransactionType.expense, color: '#DDA0DD', profileType: ProfileType.individual },
  { name: 'Educação', type: TransactionType.expense, color: '#F0E68C', profileType: ProfileType.individual },
  { name: 'Lazer', type: TransactionType.expense, color: '#87CEFA', profileType: ProfileType.individual },
  { name: 'Salário', type: TransactionType.income, color: '#90EE90', profileType: ProfileType.individual },
  { name: 'Investimentos', type: TransactionType.income, color: '#FFD700', profileType: ProfileType.individual },
  { name: 'Outros', type: TransactionType.expense, color: '#D3D3D3', profileType: ProfileType.individual },
];

const businessCategories = [
  { name: 'Vendas', type: TransactionType.income, color: '#90EE90', profileType: ProfileType.business },
  { name: 'Serviços', type: TransactionType.income, color: '#87CEEB', profileType: ProfileType.business },
  { name: 'Fornecedores', type: TransactionType.expense, color: '#FFA07A', profileType: ProfileType.business },
  { name: 'Impostos', type: TransactionType.expense, color: '#FF6B6B', profileType: ProfileType.business },
  { name: 'Folha de pagamento', type: TransactionType.expense, color: '#DDA0DD', profileType: ProfileType.business },
  { name: 'Aluguel', type: TransactionType.expense, color: '#F0E68C', profileType: ProfileType.business },
  { name: 'Marketing', type: TransactionType.expense, color: '#87CEFA', profileType: ProfileType.business },
  { name: 'Software', type: TransactionType.expense, color: '#98FB98', profileType: ProfileType.business },
  { name: 'Transporte', type: TransactionType.expense, color: '#D3D3D3', profileType: ProfileType.business },
  { name: 'Outros', type: TransactionType.expense, color: '#C0C0C0', profileType: ProfileType.business },
];

async function main() {
  console.log('Iniciando seed de categorias padrao...');

  await prisma.category.deleteMany({ where: { isDefault: true, userId: null } });

  const created = await prisma.category.createMany({
    data: [...individualCategories, ...businessCategories].map((cat) => ({
      ...cat,
      isDefault: true,
      userId: null,
    })),
  });

  console.log(`${created.count} categorias padrao inseridas.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

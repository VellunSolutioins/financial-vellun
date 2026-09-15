import {
  AccountType,
  BillingInterval,
  PrismaClient,
  ProfileType,
  TransactionType,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Preços são placeholders até a definição comercial final (ver Prompt 0).
const plans = [
  {
    code: 'vellun-mensal',
    name: 'Vellun Mensal',
    description: 'Plano mensal com acesso completo ao Financial Vellun.',
    price: '49.90',
    currency: 'BRL',
    interval: BillingInterval.monthly,
    features: {
      web: true,
      whatsapp: true,
      ai: true,
    },
  },
  {
    code: 'vellun-anual',
    name: 'Vellun Anual',
    description: 'Plano anual com acesso completo ao Financial Vellun.',
    price: '499.00',
    currency: 'BRL',
    interval: BillingInterval.annual,
    features: {
      web: true,
      whatsapp: true,
      ai: true,
    },
  },
];

/**
 * Plano de R$ 0,00 usado só para desenvolvimento local: dá acesso a tudo sem
 * passar pelo Asaas (que recusa cobranças abaixo de R$ 5,00 — ver
 * `activateFreeSubscription` em billing). Antes ele existia apenas como uma
 * linha inserida à mão no banco, então sumia a cada `prisma migrate reset`.
 */
const localDevPlan = {
  code: 'vellun-local-dev',
  name: 'Local Dev Active',
  description: 'Somente para desenvolvimento local — acesso total, sem cobrança.',
  price: '0.00',
  currency: 'BRL',
  interval: BillingInterval.monthly,
  features: {
    web: true,
    whatsapp: true,
    ai: true,
  },
};

const demoUser = {
  name: 'Vellun Solutions',
  email: 'vellunsolutions2026@gmail.com',
  password: 'qwerty123',
  cpf: '00000000191',
  whatsappPhone: '+5511999999999',
};

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

  let createdCategories = 0;

  for (const category of [...individualCategories, ...businessCategories]) {
    const existing = await prisma.category.findFirst({
      where: {
        userId: null,
        isDefault: true,
        name: category.name,
        type: category.type,
        profileType: category.profileType,
      },
    });

    if (existing) {
      await prisma.category.update({
        where: { id: existing.id },
        data: {
          color: category.color,
          isDefault: true,
        },
      });
      continue;
    }

    await prisma.category.create({
      data: {
        ...category,
        isDefault: true,
        userId: null,
      },
    });
    createdCategories += 1;
  }

  console.log(`${createdCategories} categorias padrao inseridas.`);

  console.log('Criando planos de assinatura...');

  for (const plan of plans) {
    await prisma.plan.upsert({
      where: { code: plan.code },
      update: {
        name: plan.name,
        description: plan.description,
        price: plan.price,
        currency: plan.currency,
        interval: plan.interval,
        isActive: true,
        features: plan.features,
      },
      create: {
        code: plan.code,
        name: plan.name,
        description: plan.description,
        price: plan.price,
        currency: plan.currency,
        interval: plan.interval,
        isActive: true,
        features: plan.features,
      },
    });
  }

  console.log(`${plans.length} planos de assinatura disponiveis.`);

  // Plano gratuito de desenvolvimento: criado fora de produção e, em produção,
  // desativado de forma ativa. A desativação é intencional — se a linha algum
  // dia vazar para o banco de produção (dump restaurado, seed rodado com o
  // ambiente errado), a próxima execução do seed a neutraliza em vez de deixar
  // um plano de R$ 0,00 assinável por qualquer um.
  if (process.env.NODE_ENV === 'production') {
    const { count } = await prisma.plan.updateMany({
      where: { code: localDevPlan.code, isActive: true },
      data: { isActive: false },
    });
    if (count > 0) {
      console.warn(
        `ATENCAO: plano ${localDevPlan.code} estava ativo em producao e foi desativado.`,
      );
    }
  } else {
    const { code, ...planData } = localDevPlan;
    await prisma.plan.upsert({
      where: { code },
      update: { ...planData, isActive: true },
      create: { code, ...planData, isActive: true },
    });
    console.log(
      `Plano de desenvolvimento "${localDevPlan.name}" disponivel (NODE_ENV != production).`,
    );
  }

  console.log('Criando usuario demo...');

  const passwordHash = await bcrypt.hash(demoUser.password, 12);

  const user = await prisma.user.upsert({
    where: { email: demoUser.email },
    update: {
      name: demoUser.name,
      passwordHash,
      profileType: ProfileType.individual,
    },
    create: {
      name: demoUser.name,
      email: demoUser.email,
      passwordHash,
      profileType: ProfileType.individual,
    },
  });

  await prisma.individualProfile.upsert({
    where: { userId: user.id },
    update: {
      cpf: demoUser.cpf,
    },
    create: {
      userId: user.id,
      cpf: demoUser.cpf,
    },
  });

  const existingAccount = await prisma.account.findFirst({
    where: {
      userId: user.id,
      name: 'Conta Principal',
    },
  });

  if (existingAccount) {
    await prisma.account.update({
      where: { id: existingAccount.id },
      data: {
        type: AccountType.checking,
        currency: 'BRL',
        isActive: true,
      },
    });
  } else {
    await prisma.account.create({
      data: {
        userId: user.id,
        name: 'Conta Principal',
        type: AccountType.checking,
        initialBalance: 0,
        currentBalance: 0,
        currency: 'BRL',
      },
    });
  }

  await prisma.whatsappContact.upsert({
    where: { phoneNumber: demoUser.whatsappPhone },
    update: {
      userId: user.id,
      provider: 'development',
      isVerified: true,
    },
    create: {
      userId: user.id,
      phoneNumber: demoUser.whatsappPhone,
      provider: 'development',
      isVerified: true,
    },
  });

  console.log(`Usuario demo disponivel: ${demoUser.email} / ${demoUser.password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

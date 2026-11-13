import {
  AccountType,
  BillingInterval,
  CategoryNature,
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
    name: 'Zeloo Mensal',
    description: 'Plano mensal com acesso completo ao Zeloo.',
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
    name: 'Zeloo Anual',
    description: 'Plano anual com acesso completo ao Zeloo.',
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
  {
    name: 'Alimentação',
    type: TransactionType.expense,
    color: '#E53935',
    profileType: ProfileType.individual,
  },
  {
    name: 'Mercado',
    type: TransactionType.expense,
    color: '#FB8C00',
    profileType: ProfileType.individual,
  },
  {
    name: 'Moradia',
    type: TransactionType.expense,
    color: '#1E88E5',
    profileType: ProfileType.individual,
  },
  {
    name: 'Transporte',
    type: TransactionType.expense,
    color: '#FDD835',
    profileType: ProfileType.individual,
  },
  {
    name: 'Saúde',
    type: TransactionType.expense,
    color: '#00897B',
    profileType: ProfileType.individual,
  },
  {
    name: 'Educação',
    type: TransactionType.expense,
    color: '#9CCC65',
    profileType: ProfileType.individual,
  },
  {
    name: 'Lazer',
    type: TransactionType.expense,
    color: '#EC407A',
    profileType: ProfileType.individual,
  },
  {
    name: 'Salário',
    type: TransactionType.income,
    color: '#43A047',
    profileType: ProfileType.individual,
  },
  {
    name: 'Investimentos',
    type: TransactionType.income,
    color: '#AB8F3A',
    profileType: ProfileType.individual,
  },
  {
    name: 'Outros',
    type: TransactionType.expense,
    color: '#9E9E9E',
    profileType: ProfileType.individual,
  },
  // Também criadas pela migration 20261008120000_default_categories, para
  // chegarem à produção sem depender de rodar o seed.
  {
    name: 'Streaming',
    type: TransactionType.expense,
    color: '#4DB6AC',
    profileType: ProfileType.individual,
  },
  {
    name: 'Delivery',
    type: TransactionType.expense,
    color: '#8E24AA',
    profileType: ProfileType.individual,
  },
  {
    name: 'Restaurante',
    type: TransactionType.expense,
    color: '#3949AB',
    profileType: ProfileType.individual,
  },
  // Categoria dos lançamentos de pagamento de fatura (`CARD_INVOICE_CATEGORY`).
  {
    name: 'Fatura do cartão',
    type: TransactionType.expense,
    color: '#546E7A',
    profileType: ProfileType.individual,
  },
  // Natureza própria (docs/adrs/0018): juros e tarifas aparecem à parte do
  // consumo, e compra de bem durável não é tratada como consumo do mês.
  {
    name: 'Juros e tarifas',
    type: TransactionType.expense,
    color: '#BA68C8',
    profileType: ProfileType.individual,
    nature: CategoryNature.financial_cost,
  },
  {
    name: 'Aquisição de bens',
    type: TransactionType.expense,
    color: '#8D6E63',
    profileType: ProfileType.individual,
    nature: CategoryNature.asset_acquisition,
  },
];

const businessCategories = [
  {
    name: 'Vendas',
    type: TransactionType.income,
    color: '#43A047',
    profileType: ProfileType.business,
  },
  {
    name: 'Serviços',
    type: TransactionType.income,
    color: '#AB47BC',
    profileType: ProfileType.business,
  },
  {
    name: 'Fornecedores',
    type: TransactionType.expense,
    color: '#FB8C00',
    profileType: ProfileType.business,
  },
  {
    name: 'Impostos',
    type: TransactionType.expense,
    color: '#E53935',
    profileType: ProfileType.business,
  },
  {
    name: 'Folha de pagamento',
    type: TransactionType.expense,
    color: '#00ACC1',
    profileType: ProfileType.business,
  },
  {
    name: 'Aluguel',
    type: TransactionType.expense,
    color: '#1E88E5',
    profileType: ProfileType.business,
  },
  {
    name: 'Marketing',
    type: TransactionType.expense,
    color: '#3949AB',
    profileType: ProfileType.business,
  },
  {
    name: 'Software',
    type: TransactionType.expense,
    color: '#F06292',
    profileType: ProfileType.business,
  },
  {
    name: 'Transporte',
    type: TransactionType.expense,
    color: '#FDD835',
    profileType: ProfileType.business,
  },
  {
    name: 'Outros',
    type: TransactionType.expense,
    color: '#9E9E9E',
    profileType: ProfileType.business,
  },
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
          ...('nature' in category && { nature: category.nature }),
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

  // Só cria o que falta: depois de criado, o plano é editado no painel de
  // operações (/ops/planos), e rodar o seed de novo não pode desfazer isso.
  for (const plan of plans) {
    await prisma.plan.upsert({
      where: { code: plan.code },
      update: {},
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

  await seedDemoUser();
}

/**
 * Fixture de desenvolvimento: usuário demo, conta e vínculo de WhatsApp.
 *
 * **Nunca em produção.** Três motivos, cada um suficiente sozinho:
 *
 * - o `upsert` reescreve o `passwordHash` a cada execução, então uma conta real
 *   com este e-mail teria a senha reposta para uma conhecida;
 * - a senha sai em texto puro no log, que em produção vai para o Loki;
 * - o `whatsappContact` nasce `isVerified: true` — exatamente o vínculo que a
 *   verificação de posse (plano de segurança, S1.1) passou a exigir prova para
 *   conceder. Quem controlasse o número registraria lançamentos e leria dados
 *   da conta pelo WhatsApp, sem nunca provar nada.
 *
 * Os blocos acima (categorias padrão e planos) continuam rodando em qualquer
 * ambiente: são dado de **referência**, não fixture. É o que torna o seed
 * seguro de rodar sob demanda em produção quando uma categoria nova é
 * acrescentada ao código.
 */
async function seedDemoUser() {
  if (process.env.NODE_ENV === 'production') {
    console.log('Usuario demo ignorado (NODE_ENV=production).');
    return;
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

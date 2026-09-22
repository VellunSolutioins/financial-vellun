/**
 * Semeia os contatos que o teste de carga usa (P5 do plano de performance).
 *
 * Sem isto, o loadtest mede a coisa errada. Desde a verificação de posse do
 * número (plano de segurança, S1.1), um telefone sem vínculo verificado recebe
 * "seu número ainda não está vinculado" e o job termina ali: nada de LLM, nada
 * de criação de lançamento, nada de contexto. A carga passaria com folga e não
 * diria nada sobre o caminho real.
 *
 * Os telefones são exatamente os que `phone_for()` gera em
 * `apps/ai-agent/scripts/loadtest.py` — `+5541900000000` em diante. Mudar a
 * fórmula lá exige mudar aqui.
 *
 *   NODE_ENV=development LOADTEST_PHONES=50 \
 *     pnpm --filter @financial-vellun/api exec ts-node prisma/seed-loadtest.ts
 *
 * Para remover tudo depois:
 *
 *   LOADTEST_CLEANUP=true pnpm --filter @financial-vellun/api exec ts-node prisma/seed-loadtest.ts
 */

import { AccountType, PrismaClient, ProfileType, SubscriptionStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/** Marca que identifica tudo que este script cria — e só ele. */
const MARCA = 'loadtest';
const DOMINIO = 'loadtest.invalid';

/** Espelha `phone_for(index, total)` do loadtest.py. */
function phoneFor(index: number, total: number): string {
  const sufixo = 900000000 + (index % Math.max(total, 1));
  return `+5541${String(sufixo).padStart(9, '0')}`;
}

function email(index: number): string {
  return `${MARCA}+${index}@${DOMINIO}`;
}

/**
 * Recusa rodar em produção.
 *
 * Duas checagens, não uma: `NODE_ENV` é fácil de esquecer num shell, e um banco
 * cujo nome não é de desenvolvimento é o sinal mais confiável de que a URL está
 * apontando para o lugar errado. Criar cinquenta usuários com assinatura ativa
 * em produção não é um erro que se conserta com um `DELETE`.
 */
function exigirAmbienteLocal(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Seed de carga não roda com NODE_ENV=production.');
  }
  const url = process.env.DATABASE_URL ?? '';
  const host = url.split('@').pop() ?? '';
  const pareceLocal = /localhost|127\.0\.0\.1|::1|host\.docker\.internal/.test(host);
  if (!pareceLocal && process.env.LOADTEST_ALLOW_REMOTE !== 'true') {
    throw new Error(
      'DATABASE_URL não aponta para um banco local. Se é mesmo um ambiente de ' +
        'carga dedicado, rode com LOADTEST_ALLOW_REMOTE=true.',
    );
  }
}

async function limpar(): Promise<void> {
  // A cascata de `users` leva contatos, contas, lançamentos e assinaturas.
  const { count } = await prisma.user.deleteMany({
    where: { email: { endsWith: `@${DOMINIO}` } },
  });
  console.log(`${count} usuário(s) de carga removido(s).`);
}

async function semear(total: number): Promise<void> {
  const plano = await prisma.plan.findFirst({
    where: { code: 'vellun-local-dev', isActive: true },
  });
  if (!plano) {
    throw new Error(
      'Plano vellun-local-dev não encontrado. Rode `pnpm prisma:seed` antes — o ' +
        'gate de assinatura bloquearia todas as mensagens da carga.',
    );
  }

  // Um hash só para todos: bcrypt com custo 12, cinquenta vezes, levaria mais
  // tempo que o teste de carga inteiro. Ninguém faz login com estas contas.
  const passwordHash = await bcrypt.hash(`${MARCA}-sem-uso`, 10);
  const agora = new Date();
  const fim = new Date(agora.getTime() + 365 * 24 * 60 * 60 * 1000);

  for (let i = 0; i < total; i++) {
    const usuario = await prisma.user.upsert({
      where: { email: email(i) },
      update: {},
      create: {
        email: email(i),
        name: `Carga ${i}`,
        passwordHash,
        profileType: ProfileType.individual,
      },
    });

    const conta = await prisma.account.findFirst({
      where: { userId: usuario.id, name: 'Conta de Carga' },
    });
    if (!conta) {
      await prisma.account.create({
        data: {
          userId: usuario.id,
          name: 'Conta de Carga',
          type: AccountType.checking,
          initialBalance: 0,
          currentBalance: 0,
          currency: 'BRL',
        },
      });
    }

    // O contato nasce **verificado**: é o estado que o loadtest precisa
    // exercitar. Verificar por reverse OTP não é possível aqui — o código vai
    // para o WhatsApp de alguém.
    await prisma.whatsappContact.upsert({
      where: { phoneNumber: phoneFor(i, total) },
      update: {
        userId: usuario.id,
        provider: MARCA,
        isVerified: true,
        verifiedAt: agora,
        revokedAt: null,
      },
      create: {
        userId: usuario.id,
        phoneNumber: phoneFor(i, total),
        provider: MARCA,
        isVerified: true,
        verifiedAt: agora,
      },
    });

    const assinatura = await prisma.subscription.findFirst({ where: { userId: usuario.id } });
    if (!assinatura) {
      await prisma.subscription.create({
        data: {
          userId: usuario.id,
          planId: plano.id,
          status: SubscriptionStatus.active,
          currentPeriodStart: agora,
          currentPeriodEnd: fim,
        },
      });
    }
  }

  console.log(
    `${total} contato(s) de carga verificado(s), de ${phoneFor(0, total)} a ${phoneFor(total - 1, total)}.`,
  );
  console.log('Rode a carga com --phones igual a este número.');
}

async function main(): Promise<void> {
  exigirAmbienteLocal();

  if (process.env.LOADTEST_CLEANUP === 'true') {
    await limpar();
    return;
  }

  const total = Number(process.env.LOADTEST_PHONES ?? 50);
  if (!Number.isInteger(total) || total < 1 || total > 5000) {
    throw new Error('LOADTEST_PHONES precisa ser um inteiro entre 1 e 5000.');
  }
  await semear(total);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

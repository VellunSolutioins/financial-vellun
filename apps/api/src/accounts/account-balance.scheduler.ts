import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PrismaService } from '../prisma/prisma.service';
import {
  dateOnlyString,
  endOfDayUtc,
  startOfDayUtc,
  subtractDaysSaoPaulo,
  todaySaoPaulo,
} from '../common/date.util';
import { cents } from '../common/db';
import { AccountsService } from './accounts.service';

/**
 * Dias para trás que a varredura cobre. A folga cobre API fora do ar na
 * virada do dia.
 */
const JANELA_DIAS = 7;

/**
 * Verificação diária de consistência dos saldos gravados.
 *
 * **Não liquida nada.** O saldo de uma conta comum só muda com liquidação ou
 * transferência — uma despesa que vence hoje continua em aberto até alguém
 * registrar o pagamento (docs/adrs/0018). Este cron só recompõe o cache
 * `currentBalance` a partir das movimentações e registra quando ele estava
 * divergente, o que só acontece se uma escrita falhar no meio do caminho.
 *
 * A única parte que depende do dia é a posição interna dos cartões (cobrança
 * com data do fato até hoje): por isso os cartões com lançamento na janela
 * entram sempre.
 */
@Injectable()
export class AccountBalanceScheduler {
  private readonly logger = new Logger(AccountBalanceScheduler.name);

  /**
   * Guarda de reentrância no processo. Entre réplicas não há guarda, e não
   * precisa: `recalculateBalance` recompõe o saldo do zero.
   */
  private rodando = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountsService: AccountsService,
  ) {}

  @Cron('5 0 * * *', { name: 'account-balance-consistency', timeZone: 'America/Sao_Paulo' })
  async verifyBalances(): Promise<{ checked: number; drifted: number }> {
    if (this.rodando) {
      this.logger.warn('Verificação anterior ainda em execução; pulando este ciclo');
      return { checked: 0, drifted: 0 };
    }
    this.rodando = true;

    try {
      const today = todaySaoPaulo();
      const since = startOfDayUtc(dateOnlyString(subtractDaysSaoPaulo(today, JANELA_DIAS)));
      const [cards, settled, transferred] = await Promise.all([
        this.prisma.transaction.findMany({
          where: {
            status: 'confirmed',
            account: { type: 'credit_card' },
            eventDate: { gte: since, lte: endOfDayUtc(dateOnlyString(today)) },
          },
          select: { accountId: true },
          distinct: ['accountId'],
        }),
        this.prisma.transactionSettlement.findMany({
          where: { updatedAt: { gte: since }, accountId: { not: null } },
          select: { accountId: true },
          distinct: ['accountId'],
        }),
        this.prisma.transaction.findMany({
          where: { type: 'transfer', updatedAt: { gte: since } },
          select: { accountId: true },
          distinct: ['accountId'],
        }),
      ]);
      const accountIds = new Set<string>([
        ...cards.map((r) => r.accountId),
        ...settled.map((r) => r.accountId!),
        ...transferred.map((r) => r.accountId),
      ]);

      let drifted = 0;
      for (const accountId of accountIds) {
        const before = await this.prisma.account.findUnique({
          where: { id: accountId },
          select: { currentBalance: true, type: true },
        });
        const after = await this.accountsService.recalculateBalance(accountId);
        // Cartão muda com o dia (cobrança que passou a ser efetiva): não é
        // divergência. Em conta comum, qualquer diferença é.
        if (
          before &&
          before.type !== 'credit_card' &&
          after !== undefined &&
          cents(before.currentBalance) !== cents(after)
        ) {
          drifted++;
          this.logger.warn(`Saldo divergente recomposto na conta ${accountId}`);
        }
      }
      if (drifted > 0) {
        this.logger.error(`${drifted} conta(s) com saldo gravado divergente das movimentações`);
      }
      return { checked: accountIds.size, drifted };
    } catch (error) {
      // Falhar aqui só adia a verificação; não pode derrubar o processo.
      this.logger.error(
        'Falha na verificação diária de saldos',
        error instanceof Error ? error.stack : undefined,
      );
      return { checked: 0, drifted: 0 };
    } finally {
      this.rodando = false;
    }
  }
}

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
import { AccountsService } from './accounts.service';

/**
 * Dias para trás que a varredura cobre. Um dia bastaria com o cron rodando
 * sempre; a folga cobre API fora do ar na virada do dia.
 */
const JANELA_DIAS = 7;

@Injectable()
export class AccountBalanceScheduler {
  private readonly logger = new Logger(AccountBalanceScheduler.name);

  /**
   * Guarda de reentrância no processo. Entre réplicas não há guarda, e não
   * precisa: `recalculateBalance` recompõe o saldo do zero, então rodar duas
   * vezes dá o mesmo resultado.
   */
  private rodando = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountsService: AccountsService,
  ) {}

  /**
   * O saldo só conta lançamentos até hoje. Quando uma parcela futura chega à
   * sua data, nenhuma escrita acontece — é a virada do dia que a torna
   * realizada. Este cron recompõe as contas com lançamento nos últimos dias.
   */
  @Cron('5 0 * * *', { name: 'account-balance-rollover', timeZone: 'America/Sao_Paulo' })
  async recalculateMaturedBalances(): Promise<number> {
    if (this.rodando) {
      this.logger.warn('Recálculo anterior ainda em execução; pulando este ciclo');
      return 0;
    }
    this.rodando = true;

    try {
      const today = todaySaoPaulo();
      const accounts = await this.prisma.transaction.findMany({
        where: {
          status: 'confirmed',
          transactionDate: {
            gte: startOfDayUtc(dateOnlyString(subtractDaysSaoPaulo(today, JANELA_DIAS))),
            lte: endOfDayUtc(dateOnlyString(today)),
          },
        },
        select: { accountId: true },
        distinct: ['accountId'],
      });

      for (const { accountId } of accounts) {
        await this.accountsService.recalculateBalance(accountId);
      }
      return accounts.length;
    } catch (error) {
      // Falhar aqui só atrasa o saldo até a próxima execução ou a próxima escrita
      // na conta; não pode derrubar o processo.
      this.logger.error(
        'Falha no recálculo diário de saldos',
        error instanceof Error ? error.stack : undefined,
      );
      return 0;
    } finally {
      this.rodando = false;
    }
  }
}

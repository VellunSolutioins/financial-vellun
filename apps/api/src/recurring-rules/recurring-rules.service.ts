import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, RecurringFrequency, RecurringRule } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  addDaysSaoPaulo,
  calendarDayFromUtcDate,
  compareCalendarDays,
  competenceString,
  dateOnlyString,
  daysBetweenCalendarDays,
  maxCalendarDay,
  parseDateOnly,
  subtractDaysSaoPaulo,
  todaySaoPaulo,
} from '../common/date.util';

import { CreateRecurringRuleDto } from './dto/create-recurring-rule.dto';
import { UpdateRecurringRuleDto } from './dto/update-recurring-rule.dto';

export const FREQUENCY_STEP_MONTHS: Record<RecurringFrequency, number> = {
  monthly: 1,
  bimonthly: 2,
  semiannual: 6,
  annual: 12,
};

/**
 * Valor mensal equivalente de uma regra. Somar o valor nominal de regras com
 * frequências diferentes trata um seguro anual de R$ 2.400 como se fossem
 * R$ 2.400 por mês — o que distorce o percentual de comprometimento e a faixa
 * de saúde. Dividir pelo passo em meses coloca todas na mesma unidade.
 */
export function monthlyEquivalent(rule: {
  amount: unknown;
  frequency: RecurringFrequency;
}): number {
  return Number(rule.amount) / FREQUENCY_STEP_MONTHS[rule.frequency];
}

/** Faixas de comprometimento da receita com fixos (doc "Recorrências"). */
const HEALTH_BANDS = [
  { max: 40, key: 'excelente', label: 'Excelente margem' },
  { max: 50, key: 'saudavel', label: 'Saudável' },
  { max: 60, key: 'atencao', label: 'Atenção' },
  { max: 70, key: 'apertado', label: 'Orçamento apertado' },
] as const;

function healthFromPercentage(percentage: number): { key: string; label: string } {
  for (const band of HEALTH_BANDS) {
    if (percentage <= band.max) return { key: band.key, label: band.label };
  }
  return { key: 'alto_risco', label: 'Alto risco' };
}

/** A regra vence no dia informado (São Paulo)? Considera frequência, janela e dia clampado ao fim do mês. */
function isRuleDueOn(
  rule: Pick<RecurringRule, 'startDate' | 'endDate' | 'frequency' | 'dueDay'>,
  today: { year: number; monthIndex: number; day: number },
): boolean {
  const startY = rule.startDate.getUTCFullYear();
  const startM = rule.startDate.getUTCMonth();
  if (today.year < startY || (today.year === startY && today.monthIndex < startM)) return false;

  const monthsSinceStart = (today.year - startY) * 12 + (today.monthIndex - startM);
  const step = FREQUENCY_STEP_MONTHS[rule.frequency];
  if (monthsSinceStart % step !== 0) return false;

  const daysInMonth = new Date(Date.UTC(today.year, today.monthIndex + 1, 0)).getUTCDate();
  const effectiveDueDay = Math.min(rule.dueDay, daysInMonth);
  if (today.day !== effectiveDueDay) return false;

  // Janela [startDate, endDate] comparada por data completa (meio-dia UTC, o
  // mesmo horário que parseDateOnly grava) — comparar só ano+mês deixava
  // passar vencimentos antes do início / depois do término dentro do mês de
  // borda (ex.: endDate no dia 10 ainda gerava no dia 25 do mesmo mês).
  const dueDate = Date.UTC(today.year, today.monthIndex, effectiveDueDay, 12, 0, 0);
  if (dueDate < rule.startDate.getTime()) return false;
  if (rule.endDate && dueDate > rule.endDate.getTime()) return false;

  return true;
}

@Injectable()
export class RecurringRulesService {
  private readonly logger = new Logger(RecurringRulesService.name);

  constructor(private prisma: PrismaService) {}

  async findAll(userId: string) {
    return this.prisma.recurringRule.findMany({
      where: { userId },
      include: { category: true, account: true },
      orderBy: [{ isActive: 'desc' }, { dueDay: 'asc' }],
    });
  }

  async summary(userId: string) {
    const rules = await this.prisma.recurringRule.findMany({
      where: { userId, isActive: true },
      include: { category: true },
    });

    // Tudo normalizado para o equivalente mensal — ver monthlyEquivalent().
    const income = rules
      .filter((r) => r.type === 'income')
      .reduce((sum, r) => sum + monthlyEquivalent(r), 0);
    const committed = rules
      .filter((r) => r.type === 'expense')
      .reduce((sum, r) => sum + monthlyEquivalent(r), 0);

    if (income <= 0) {
      return {
        income,
        committed,
        percentage: 0,
        health: { key: 'sem_receita', label: 'Cadastre uma receita fixa' },
        byCategory: [] as Array<{
          categoryId: string | null;
          categoryName: string;
          color: string | null;
          total: number;
          percentage: number;
        }>,
      };
    }

    const percentage = (committed / income) * 100;

    const byCategoryMap = new Map<
      string,
      { categoryId: string | null; categoryName: string; color: string | null; total: number }
    >();
    for (const rule of rules.filter((r) => r.type === 'expense')) {
      const key = rule.categoryId ?? 'uncategorized';
      const entry = byCategoryMap.get(key) ?? {
        categoryId: rule.categoryId,
        categoryName: rule.category?.name ?? 'Sem categoria',
        color: rule.category?.color ?? null,
        total: 0,
      };
      entry.total += monthlyEquivalent(rule);
      byCategoryMap.set(key, entry);
    }
    const byCategory = [...byCategoryMap.values()]
      .map((entry) => ({
        ...entry,
        percentage: committed > 0 ? (entry.total / committed) * 100 : 0,
      }))
      .sort((a, b) => b.total - a.total);

    return { income, committed, percentage, health: healthFromPercentage(percentage), byCategory };
  }

  async create(userId: string, dto: CreateRecurringRuleDto) {
    await this.validateOwnership(userId, dto.accountId, dto.categoryId);
    return this.prisma.recurringRule.create({
      data: {
        userId,
        accountId: dto.accountId,
        categoryId: dto.categoryId || null,
        type: dto.type,
        description: dto.description,
        amount: dto.amount,
        frequency: dto.frequency,
        dueDay: dto.dueDay,
        startDate: parseDateOnly(dto.startDate),
        endDate: dto.endDate ? parseDateOnly(dto.endDate) : null,
      },
      include: { category: true, account: true },
    });
  }

  async update(userId: string, id: string, dto: UpdateRecurringRuleDto) {
    const existing = await this.findOwned(userId, id);
    if (dto.accountId !== undefined || dto.categoryId !== undefined) {
      await this.validateOwnership(userId, dto.accountId, dto.categoryId);
    }
    return this.prisma.recurringRule.update({
      where: { id: existing.id },
      data: {
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.amount !== undefined && { amount: dto.amount }),
        ...(dto.accountId !== undefined && { accountId: dto.accountId }),
        ...(dto.categoryId !== undefined && { categoryId: dto.categoryId || null }),
        ...(dto.frequency !== undefined && { frequency: dto.frequency }),
        ...(dto.dueDay !== undefined && { dueDay: dto.dueDay }),
        ...(dto.startDate !== undefined && { startDate: parseDateOnly(dto.startDate) }),
        ...(dto.endDate !== undefined && { endDate: dto.endDate ? parseDateOnly(dto.endDate) : null }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
      include: { category: true, account: true },
    });
  }

  async remove(userId: string, id: string) {
    const existing = await this.findOwned(userId, id);
    return this.prisma.recurringRule.delete({ where: { id: existing.id } });
  }

  /** Roda diariamente às 04:00 (São Paulo) — gera os lançamentos que vencem hoje, para todos os usuários. */
  @Cron('0 4 * * *', { timeZone: 'America/Sao_Paulo' })
  async generateDueForAllUsers() {
    const result = await this.generateDue();
    if (result.created > 0) {
      this.logger.log(`Recorrências: ${result.created} lançamento(s) gerado(s) para hoje.`);
    }
  }

  /**
   * Gera as ocorrências pendentes de cada regra, varrendo os dias ainda não
   * processados (limitado a `lookbackDays`). Sem essa varredura, um cron
   * perdido (deploy, container reiniciando, instância fora do ar) pula o
   * vencimento em silêncio: no dia seguinte a regra não vence mais e não há
   * caminho de recuperação.
   *
   * A janela de cada regra começa em `lastGeneratedAt + 1 dia`, e ao final a
   * marca-d'água avança para hoje. É ela — e não o `@@unique`
   * (recurringRuleId, competenceMonth) — que garante que um dia já varrido
   * nunca é reprocessado: o índice único some junto com a linha quando o
   * usuário exclui o lançamento de vez (`hard_delete=true`, o que a tela de
   * Lançamentos sempre faz), e a varredura seguinte o recriaria.
   *
   * Sem `userId`, roda para todos (uso do cron); com `userId`, só dele (endpoint manual).
   */
  async generateDue(userId?: string, lookbackDays = 7): Promise<{ created: number }> {
    const today = todaySaoPaulo();
    const todayDate = parseDateOnly(dateOnlyString(today));
    const rules = await this.prisma.recurringRule.findMany({
      where: { isActive: true, ...(userId ? { userId } : {}) },
    });

    let created = 0;
    for (const rule of rules) {
      // Dias a varrer: do primeiro não processado até hoje, no máximo
      // `lookbackDays` para trás (regra nova ou parada há meses não dispara
      // uma enxurrada retroativa).
      const oldestAllowed = subtractDaysSaoPaulo(today, lookbackDays);
      const firstUnscanned = rule.lastGeneratedAt
        ? addDaysSaoPaulo(calendarDayFromUtcDate(rule.lastGeneratedAt), 1)
        : oldestAllowed;
      const from = maxCalendarDay(firstUnscanned, oldestAllowed);

      for (let day = from; compareCalendarDays(day, today) <= 0; day = addDaysSaoPaulo(day, 1)) {
        if (!isRuleDueOn(rule, day)) continue;

        const competenceMonth = competenceString(day);
        const dueDateOnly = dateOnlyString(day);
        const lateBy = daysBetweenCalendarDays(day, today);

        try {
          await this.prisma.transaction.create({
            data: {
              userId: rule.userId,
              // Gerado pelo cron, sem autor humano — atribui ao dono da regra.
              createdByUserId: rule.userId,
              accountId: rule.accountId,
              categoryId: rule.categoryId,
              type: rule.type,
              amount: rule.amount,
              description: rule.description,
              // Data de vencimento do dia varrido, não a data em que o cron
              // rodou — senão o lançamento recuperado aparece com data errada.
              transactionDate: parseDateOnly(dueDateOnly),
              status: 'pending',
              source: 'recurring',
              recurringRuleId: rule.id,
              competenceMonth,
            },
          });
          created += 1;
          if (lateBy > 0) {
            this.logger.warn(
              `Recorrência ${rule.id}: backfill de ${lateBy} dia(s) atrás (competência ${competenceMonth}) — sinal de que o cron falhou.`,
            );
          }
        } catch (error) {
          // Segunda linha de defesa contra duplicata (duas instâncias do cron
          // rodando ao mesmo tempo, ou chamada manual concorrente).
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            continue;
          }
          throw error;
        }
      }

      // Avança a marca-d'água mesmo quando nada foi gerado: o que importa é
      // que os dias até hoje já foram avaliados.
      await this.prisma.recurringRule.update({
        where: { id: rule.id },
        data: { lastGeneratedAt: todayDate },
      });
    }
    return { created };
  }

  private async findOwned(userId: string, id: string) {
    const rule = await this.prisma.recurringRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('Recorrência não encontrada');
    if (rule.userId !== userId) throw new NotFoundException('Recorrência não encontrada');
    return rule;
  }

  private async validateOwnership(userId: string, accountId?: string, categoryId?: string) {
    if (accountId !== undefined) {
      if (!accountId) throw new BadRequestException('Conta inválida');
      const account = await this.prisma.account.findUnique({ where: { id: accountId } });
      if (!account || account.userId !== userId) {
        throw new BadRequestException('Conta inválida');
      }
    }
    if (categoryId) {
      const category = await this.prisma.category.findUnique({ where: { id: categoryId } });
      if (!category || (category.userId !== null && category.userId !== userId)) {
        throw new BadRequestException('Categoria inválida');
      }
    }
  }
}

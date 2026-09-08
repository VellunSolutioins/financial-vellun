import { Injectable, NotFoundException } from '@nestjs/common';
import { Reminder } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { addMonthsUtc, parseDateOnly, todaySaoPaulo } from '../common/date.util';

import { CreateReminderDto } from './dto/create-reminder.dto';
import { UpdateReminderDto } from './dto/update-reminder.dto';

function todayDateString(): string {
  const { year, monthIndex, day } = todaySaoPaulo();
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 'paid' | 'overdue' | 'pending' — "vencido" nunca é persistido, sempre derivado da data. */
function derivedStatus(reminder: Pick<Reminder, 'status' | 'dueDate'>): 'paid' | 'overdue' | 'pending' {
  if (reminder.status === 'paid') return 'paid';
  const dueDateString = reminder.dueDate.toISOString().slice(0, 10);
  return dueDateString < todayDateString() ? 'overdue' : 'pending';
}

@Injectable()
export class RemindersService {
  constructor(private prisma: PrismaService) {}

  /**
   * `month` (formato "YYYY-MM") filtra pelo mesmo padrão de abas de mês do
   * resto do app (ver monthLabel/monthRange em lancamentos/page.tsx). Lembretes
   * recorrentes aparecem de `dueDate` em diante (até `recurrenceEndDate`, se
   * houver) — só os não recorrentes ficam restritos ao mês do vencimento.
   *
   * O piso em `dueDate` importa: sem ele o lembrete aparecia em meses
   * anteriores ao próprio vencimento, e marcar como pago numa aba antiga
   * empurrava a data real para frente, pulando um mês de verdade em silêncio
   * (ver pay(), que "rola" o mesmo registro).
   */
  async findAll(userId: string, month?: string) {
    const reminders = await this.prisma.reminder.findMany({
      where: { userId },
      orderBy: { dueDate: 'asc' },
    });
    const mapped = reminders.map((r) => ({
      ...r,
      amount: r.amount ? Number(r.amount) : null,
      derivedStatus: derivedStatus(r),
    }));

    if (!month) return mapped;

    return mapped.filter((r) => {
      const dueMonth = r.dueDate.toISOString().slice(0, 7);
      if (r.isRecurrent) {
        if (month < dueMonth) return false;
        if (!r.recurrenceEndDate) return true;
        return month <= r.recurrenceEndDate.toISOString().slice(0, 7);
      }
      return dueMonth === month;
    });
  }

  async create(userId: string, dto: CreateReminderDto) {
    return this.prisma.reminder.create({
      data: {
        userId,
        title: dto.title,
        amount: dto.amount ?? null,
        dueDate: parseDateOnly(dto.dueDate),
        isRecurrent: dto.isRecurrent ?? false,
        recurrenceEndDate: dto.recurrenceEndDate ? parseDateOnly(dto.recurrenceEndDate) : null,
      },
    });
  }

  async update(userId: string, id: string, dto: UpdateReminderDto) {
    const existing = await this.findOwned(userId, id);
    return this.prisma.reminder.update({
      where: { id: existing.id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.amount !== undefined && { amount: dto.amount }),
        ...(dto.dueDate !== undefined && { dueDate: parseDateOnly(dto.dueDate) }),
        ...(dto.isRecurrent !== undefined && { isRecurrent: dto.isRecurrent }),
        ...(dto.recurrenceEndDate !== undefined && {
          recurrenceEndDate: dto.recurrenceEndDate ? parseDateOnly(dto.recurrenceEndDate) : null,
        }),
      },
    });
  }

  /**
   * Marca como pago. Se for recorrente e ainda dentro de `recurrenceEndDate`
   * (quando definida), não acumula um lembrete novo por mês: o próprio
   * registro "rola" para o vencimento do mês seguinte e volta a ficar
   * pendente. Ao ultrapassar a data-limite, fica marcado como pago de vez
   * (não rola mais).
   */
  async pay(userId: string, id: string) {
    const existing = await this.findOwned(userId, id);

    if (existing.isRecurrent) {
      const nextDueDate = addMonthsUtc(existing.dueDate, 1);
      const withinRange = !existing.recurrenceEndDate || nextDueDate <= existing.recurrenceEndDate;
      if (withinRange) {
        return this.prisma.reminder.update({
          where: { id: existing.id },
          data: { dueDate: nextDueDate, status: 'pending' },
        });
      }
    }

    return this.prisma.reminder.update({ where: { id: existing.id }, data: { status: 'paid' } });
  }

  /** Desfaz a marcação de pago (só se aplica a lembretes não recorrentes). */
  async unpay(userId: string, id: string) {
    const existing = await this.findOwned(userId, id);
    return this.prisma.reminder.update({ where: { id: existing.id }, data: { status: 'pending' } });
  }

  async remove(userId: string, id: string) {
    const existing = await this.findOwned(userId, id);
    return this.prisma.reminder.delete({ where: { id: existing.id } });
  }

  private async findOwned(userId: string, id: string) {
    const reminder = await this.prisma.reminder.findUnique({ where: { id } });
    if (!reminder || reminder.userId !== userId) throw new NotFoundException('Lembrete não encontrado');
    return reminder;
  }
}

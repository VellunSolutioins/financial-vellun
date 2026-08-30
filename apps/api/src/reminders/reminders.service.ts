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

  async findAll(userId: string) {
    const reminders = await this.prisma.reminder.findMany({
      where: { userId },
      orderBy: { dueDate: 'asc' },
    });
    return reminders.map((r) => ({ ...r, amount: r.amount ? Number(r.amount) : null, derivedStatus: derivedStatus(r) }));
  }

  async create(userId: string, dto: CreateReminderDto) {
    return this.prisma.reminder.create({
      data: {
        userId,
        title: dto.title,
        amount: dto.amount ?? null,
        dueDate: parseDateOnly(dto.dueDate),
        isRecurrent: dto.isRecurrent ?? false,
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
      },
    });
  }

  /** Marca como pago; se recorrente, já cria o lembrete do mês seguinte (mesmo dia, +1 mês clampado). */
  async pay(userId: string, id: string) {
    const existing = await this.findOwned(userId, id);
    const paid = await this.prisma.reminder.update({
      where: { id: existing.id },
      data: { status: 'paid' },
    });

    if (existing.isRecurrent) {
      await this.prisma.reminder.create({
        data: {
          userId,
          title: existing.title,
          amount: existing.amount,
          dueDate: addMonthsUtc(existing.dueDate, 1),
          isRecurrent: true,
        },
      });
    }

    return paid;
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

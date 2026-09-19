import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { parseDateOnly } from '../common/date.util';

import { CreateAgendaEventDto } from './dto/create-agenda-event.dto';
import { UpdateAgendaEventDto } from './dto/update-agenda-event.dto';

@Injectable()
export class AgendaEventsService {
  constructor(private prisma: PrismaService) {}

  /** `month` (formato "YYYY-MM") filtra pelo mesmo padrão de abas de mês do resto do app. */
  async findAll(userId: string, month?: string) {
    const events = await this.prisma.agendaEvent.findMany({
      where: { userId },
      orderBy: [{ eventDate: 'asc' }, { eventTime: 'asc' }],
    });
    if (!month) return events;
    return events.filter((e) => e.eventDate.toISOString().slice(0, 7) === month);
  }

  async create(userId: string, dto: CreateAgendaEventDto) {
    return this.prisma.agendaEvent.create({
      data: {
        userId,
        title: dto.title,
        description: dto.description ?? null,
        eventDate: parseDateOnly(dto.eventDate),
        eventTime: dto.eventTime ?? null,
        color: dto.color ?? null,
      },
    });
  }

  async update(userId: string, id: string, dto: UpdateAgendaEventDto) {
    const existing = await this.findOwned(userId, id);
    return this.prisma.agendaEvent.update({
      where: { id: existing.id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.eventDate !== undefined && { eventDate: parseDateOnly(dto.eventDate) }),
        ...(dto.eventTime !== undefined && { eventTime: dto.eventTime }),
        ...(dto.color !== undefined && { color: dto.color }),
      },
    });
  }

  async remove(userId: string, id: string) {
    const existing = await this.findOwned(userId, id);
    return this.prisma.agendaEvent.delete({ where: { id: existing.id } });
  }

  private async findOwned(userId: string, id: string) {
    const event = await this.prisma.agendaEvent.findUnique({ where: { id } });
    if (!event || event.userId !== userId) throw new NotFoundException('Compromisso não encontrado');
    return event;
  }
}

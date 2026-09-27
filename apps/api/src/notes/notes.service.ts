import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import { CreateNoteDto } from './dto/create-note.dto';
import { UpdateNoteDto } from './dto/update-note.dto';

@Injectable()
export class NotesService {
  constructor(private prisma: PrismaService) {}

  async findAll(userId: string) {
    return this.prisma.note.findMany({
      where: { userId },
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async create(userId: string, dto: CreateNoteDto) {
    return this.prisma.note.create({
      data: { userId, title: dto.title, content: dto.content },
    });
  }

  async update(userId: string, id: string, dto: UpdateNoteDto) {
    const existing = await this.findOwned(userId, id);
    return this.prisma.note.update({
      where: { id: existing.id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.content !== undefined && { content: dto.content }),
      },
    });
  }

  async togglePin(userId: string, id: string) {
    const existing = await this.findOwned(userId, id);
    return this.prisma.note.update({
      where: { id: existing.id },
      data: { isPinned: !existing.isPinned },
    });
  }

  async remove(userId: string, id: string) {
    const existing = await this.findOwned(userId, id);
    return this.prisma.note.delete({ where: { id: existing.id } });
  }

  private async findOwned(userId: string, id: string) {
    const note = await this.prisma.note.findUnique({ where: { id } });
    if (!note || note.userId !== userId) throw new NotFoundException('Anotação não encontrada');
    return note;
  }
}

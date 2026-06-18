import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ContactType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';

@Injectable()
export class ContactsService {
  constructor(private prisma: PrismaService) {}

  async findAll(userId: string, type?: ContactType, search?: string) {
    const where: Prisma.ContactWhereInput = { userId, isActive: true };
    if (type) where.type = type;
    if (search) where.name = { contains: search, mode: 'insensitive' };
    return this.prisma.contact.findMany({ where, orderBy: { name: 'asc' } });
  }

  async findOne(userId: string, id: string) {
    const contact = await this.prisma.contact.findUnique({ where: { id } });
    if (!contact) throw new NotFoundException('Contato não encontrado');
    if (contact.userId !== userId) throw new ForbiddenException();
    return contact;
  }

  async create(userId: string, dto: CreateContactDto) {
    return this.prisma.contact.create({ data: { userId, ...dto } });
  }

  async update(userId: string, id: string, dto: UpdateContactDto) {
    const contact = await this.findOne(userId, id);
    return this.prisma.contact.update({ where: { id: contact.id }, data: dto });
  }

  async remove(userId: string, id: string) {
    const contact = await this.findOne(userId, id);
    return this.prisma.contact.update({
      where: { id: contact.id },
      data: { isActive: false },
    });
  }
}

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ProfileType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(private prisma: PrismaService) {}

  async findAll(userId: string, profileType: ProfileType) {
    return this.prisma.category.findMany({
      where: {
        profileType,
        OR: [{ userId }, { isDefault: true, userId: null }],
      },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  }

  async create(userId: string, profileType: ProfileType, dto: CreateCategoryDto) {
    return this.prisma.category.create({
      data: { ...dto, userId, profileType },
    });
  }

  async update(userId: string, id: string, dto: UpdateCategoryDto) {
    const category = await this.prisma.category.findUnique({ where: { id } });
    if (!category) throw new NotFoundException('Categoria não encontrada');
    if (category.isDefault || category.userId !== userId) {
      throw new ForbiddenException('Não é possível editar esta categoria');
    }
    return this.prisma.category.update({ where: { id }, data: dto });
  }

  async remove(userId: string, id: string) {
    const category = await this.prisma.category.findUnique({ where: { id } });
    if (!category) throw new NotFoundException('Categoria não encontrada');
    if (category.isDefault || category.userId !== userId) {
      throw new ForbiddenException('Não é possível excluir esta categoria');
    }

    const hasTransactions = await this.prisma.transaction.count({ where: { categoryId: id } });
    if (hasTransactions > 0) {
      throw new BadRequestException('Categoria possui lançamentos vinculados e não pode ser excluída');
    }

    return this.prisma.category.delete({ where: { id } });
  }
}

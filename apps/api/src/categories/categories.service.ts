import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ProfileType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { withoutShadowedDefaults } from './default-categories';

@Injectable()
export class CategoriesService {
  constructor(private prisma: PrismaService) {}

  async findAll(userId: string, profileType: ProfileType) {
    const categories = await this.prisma.category.findMany({
      where: {
        profileType,
        OR: [{ userId }, { isDefault: true, userId: null }],
      },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      // Contagem só do próprio usuário: categorias padrão são compartilhadas.
      include: {
        _count: {
          select: {
            transactions: { where: { userId } },
            spendingGoals: { where: { userId } },
          },
        },
      },
    });
    return withoutShadowedDefaults(categories).map(({ _count, ...category }) => ({
      ...category,
      transactionCount: _count.transactions,
      spendingGoalCount: _count.spendingGoals,
    }));
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

    // Lançamentos vinculados passam a "Sem categoria" (null), estado que o
    // resto do sistema já trata. Metas da categoria somem junto (FK cascade):
    // meta de gasto sem categoria não tem o que medir.
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.transaction.updateMany({
        where: { categoryId: id },
        data: { categoryId: null },
      });
      await tx.category.delete({ where: { id } });
      return { id, uncategorizedTransactions: count };
    });
  }
}

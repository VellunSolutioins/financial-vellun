import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BillingInterval, OpsAuditResult, Plan, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { OpsAuditService } from '../audit/ops-audit.service';
import { CurrentOpsOperator } from '../auth/decorators/current-operator.decorator';
import { OPS_AUDIT_ACTIONS, OPS_AUDIT_TARGETS } from '../ops.constants';
import { CreatePlanDto, UpdatePlanDto } from './dto/plan.dto';

/** Plano como o painel o vê. `price` em string com duas casas, como a API de billing. */
export interface PlanView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price: string;
  currency: string;
  interval: BillingInterval;
  /** Exibido na tela de assinatura (e aceita checkout novo). */
  isActive: boolean;
  /** Assinaturas que já usaram o plano, em qualquer status. */
  subscriptionCount: number;
  createdAt: Date;
  updatedAt: Date;
}

type PlanRow = Plan & { _count: { subscriptions: number } };

const WITH_COUNT = { _count: { select: { subscriptions: true } } } as const;

/**
 * Cadastro de planos de assinatura pelo painel — antes, só por SQL.
 *
 * `isActive` é o "exibir na tela de assinatura": é o filtro de
 * `SubscriptionService.getActivePlans` e do checkout. Plano oculto não aceita
 * assinatura nova; quem já assina segue normalmente.
 *
 * Toda escrita grava a auditoria (antes e depois) na mesma transação — mesma
 * regra de {@link OpsOperatorsService.update}.
 */
@Injectable()
export class OpsPlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OpsAuditService,
  ) {}

  async list(): Promise<PlanView[]> {
    const rows = await this.prisma.plan.findMany({
      include: WITH_COUNT,
      orderBy: [{ isActive: 'desc' }, { price: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toView);
  }

  async create(dto: CreatePlanDto, actor: CurrentOpsOperator): Promise<PlanView> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.plan.create({
          data: {
            code: dto.code,
            name: dto.name.trim(),
            description: dto.description?.trim() || null,
            price: dto.price,
            interval: dto.interval,
            isActive: dto.isActive,
          },
          include: WITH_COUNT,
        });
        await this.audit.record(
          {
            operatorId: actor.id,
            action: OPS_AUDIT_ACTIONS.planCreated,
            targetType: OPS_AUDIT_TARGETS.plan,
            targetId: created.id,
            reason: dto.reason,
            result: OpsAuditResult.success,
            afterState: snapshot(created),
          },
          tx,
        );
        return toView(created);
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`Já existe um plano com o código "${dto.code}".`);
      }
      throw err;
    }
  }

  /**
   * Preço novo vale para checkouts novos: a assinatura já criada no provedor
   * de pagamentos mantém o valor dela. Ciclo não muda em plano que já tem
   * assinatura — o provedor cobra pelo ciclo contratado; crie outro plano.
   */
  async update(id: string, dto: UpdatePlanDto, actor: CurrentOpsOperator): Promise<PlanView> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.plan.findUnique({ where: { id }, include: WITH_COUNT });
      if (!before) throw new NotFoundException('Plano não encontrado.');

      const data: Prisma.PlanUpdateInput = {};
      if (dto.name !== undefined && dto.name.trim() !== before.name) data.name = dto.name.trim();
      if (dto.description !== undefined) {
        const description = dto.description?.trim() || null;
        if (description !== before.description) data.description = description;
      }
      if (dto.price !== undefined && !new Prisma.Decimal(dto.price).equals(before.price)) {
        data.price = dto.price;
      }
      if (dto.interval !== undefined && dto.interval !== before.interval) {
        if (before._count.subscriptions > 0) {
          throw new ConflictException(
            'Plano com assinaturas não muda de ciclo. Crie outro plano e oculte este.',
          );
        }
        data.interval = dto.interval;
      }
      if (dto.isActive !== undefined && dto.isActive !== before.isActive) {
        data.isActive = dto.isActive;
      }
      if (Object.keys(data).length === 0) throw new BadRequestException('Nada a alterar.');

      const after = await tx.plan.update({ where: { id }, data, include: WITH_COUNT });
      await this.audit.record(
        {
          operatorId: actor.id,
          action: OPS_AUDIT_ACTIONS.planUpdated,
          targetType: OPS_AUDIT_TARGETS.plan,
          targetId: id,
          reason: dto.reason,
          result: OpsAuditResult.success,
          beforeState: snapshot(before),
          afterState: snapshot(after),
        },
        tx,
      );
      return toView(after);
    });
  }

  /** Só sai o plano que nunca teve assinatura; o que teve, se oculta. */
  async remove(id: string, reason: string, actor: CurrentOpsOperator): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.plan.findUnique({ where: { id }, include: WITH_COUNT });
      if (!before) throw new NotFoundException('Plano não encontrado.');
      if (before._count.subscriptions > 0) {
        throw new ConflictException(
          'Plano com assinaturas não pode ser excluído: oculte-o da tela de assinatura.',
        );
      }

      await tx.plan.delete({ where: { id } });
      await this.audit.record(
        {
          operatorId: actor.id,
          action: OPS_AUDIT_ACTIONS.planDeleted,
          targetType: OPS_AUDIT_TARGETS.plan,
          targetId: id,
          reason,
          result: OpsAuditResult.success,
          beforeState: snapshot(before),
        },
        tx,
      );
    });
  }
}

function toView(row: PlanRow): PlanView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    price: row.price.toFixed(2),
    currency: row.currency,
    interval: row.interval,
    isActive: row.isActive,
    subscriptionCount: row._count.subscriptions,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** O que a auditoria guarda do plano: o que o painel edita. */
function snapshot(plan: Plan): Prisma.InputJsonValue {
  return {
    code: plan.code,
    name: plan.name,
    description: plan.description,
    price: plan.price.toFixed(2),
    interval: plan.interval,
    isActive: plan.isActive,
  };
}

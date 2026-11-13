import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OpsAuditResult, Prisma, SubscriptionExemption } from '@prisma/client';

import { normalizePhone, phoneVariants } from '../../common/phone.util';
import { PrismaService } from '../../prisma/prisma.service';
import { OpsAuditService } from '../audit/ops-audit.service';
import { CurrentOpsOperator } from '../auth/decorators/current-operator.decorator';
import { maskPhone } from '../failures/failure-masking';
import { OPS_AUDIT_ACTIONS, OPS_AUDIT_TARGETS } from '../ops.constants';
import { CreateExemptionDto, UpdateExemptionDto } from './dto/exemption.dto';

export interface ExemptionView {
  id: string;
  name: string;
  /** Mascarado como cadastrado: `(41) 99999-9999`. */
  phone: string;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: { githubLogin: string } | null;
}

const WITH_OPERATOR = { updatedBy: { select: { githubLogin: true } } } as const;

type ExemptionRow = SubscriptionExemption & { updatedBy: { githubLogin: string } | null };

/**
 * Números de WhatsApp isentos de assinatura (sócios, equipe). A regra que os
 * usa está em `SubscriptionAccessService.isExempt`: isenta a conta cujo
 * WhatsApp **verificado** é um destes números.
 *
 * Toda escrita grava a auditoria na mesma transação. O telefone vai para a
 * trilha mascarado; a observação faz o papel de justificativa.
 */
@Injectable()
export class OpsExemptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OpsAuditService,
  ) {}

  async list(): Promise<ExemptionView[]> {
    const rows = await this.prisma.subscriptionExemption.findMany({
      include: WITH_OPERATOR,
      orderBy: { name: 'asc' },
    });
    return rows.map(toView);
  }

  async create(dto: CreateExemptionDto, actor: CurrentOpsOperator): Promise<ExemptionView> {
    const phoneNumber = normalizePhone(dto.phone);
    return this.prisma.$transaction(async (tx) => {
      await this.assertUnique(tx, phoneNumber);
      const created = await tx.subscriptionExemption.create({
        data: {
          name: dto.name.trim(),
          phone: dto.phone,
          phoneNumber,
          note: dto.note?.trim() || null,
          updatedByOperatorId: actor.id,
        },
        include: WITH_OPERATOR,
      });
      await this.audit.record(
        {
          operatorId: actor.id,
          action: OPS_AUDIT_ACTIONS.exemptionCreated,
          targetType: OPS_AUDIT_TARGETS.subscriptionExemption,
          targetId: created.id,
          reason: created.note,
          result: OpsAuditResult.success,
          afterState: snapshot(created),
        },
        tx,
      );
      return toView(created);
    });
  }

  async update(
    id: string,
    dto: UpdateExemptionDto,
    actor: CurrentOpsOperator,
  ): Promise<ExemptionView> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.subscriptionExemption.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Isenção não encontrada.');

      const data: Prisma.SubscriptionExemptionUncheckedUpdateInput = {};
      if (dto.name !== undefined && dto.name.trim() !== before.name) data.name = dto.name.trim();
      if (dto.phone !== undefined && dto.phone !== before.phone) {
        const phoneNumber = normalizePhone(dto.phone);
        await this.assertUnique(tx, phoneNumber, id);
        data.phone = dto.phone;
        data.phoneNumber = phoneNumber;
      }
      if (dto.note !== undefined) {
        const note = dto.note?.trim() || null;
        if (note !== before.note) data.note = note;
      }
      if (Object.keys(data).length === 0) throw new BadRequestException('Nada a alterar.');
      data.updatedByOperatorId = actor.id;

      const after = await tx.subscriptionExemption.update({
        where: { id },
        data,
        include: WITH_OPERATOR,
      });
      await this.audit.record(
        {
          operatorId: actor.id,
          action: OPS_AUDIT_ACTIONS.exemptionUpdated,
          targetType: OPS_AUDIT_TARGETS.subscriptionExemption,
          targetId: id,
          reason: after.note,
          result: OpsAuditResult.success,
          beforeState: snapshot(before),
          afterState: snapshot(after),
        },
        tx,
      );
      return toView(after);
    });
  }

  async remove(id: string, reason: string, actor: CurrentOpsOperator): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.subscriptionExemption.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Isenção não encontrada.');

      await tx.subscriptionExemption.delete({ where: { id } });
      await this.audit.record(
        {
          operatorId: actor.id,
          action: OPS_AUDIT_ACTIONS.exemptionDeleted,
          targetType: OPS_AUDIT_TARGETS.subscriptionExemption,
          targetId: id,
          reason,
          result: OpsAuditResult.success,
          beforeState: snapshot(before),
        },
        tx,
      );
    });
  }

  /** O mesmo número com ou sem o nono dígito também conta como repetido. */
  private async assertUnique(tx: Prisma.TransactionClient, phoneNumber: string, exceptId?: string) {
    const existing = await tx.subscriptionExemption.findFirst({
      where: {
        phoneNumber: { in: phoneVariants(phoneNumber) },
        ...(exceptId && { id: { not: exceptId } }),
      },
      select: { name: true },
    });
    if (existing) {
      throw new ConflictException(`Este WhatsApp já está isento (${existing.name}).`);
    }
  }
}

function toView(row: ExemptionRow): ExemptionView {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/** O que a auditoria guarda: o telefone mascarado, como nas falhas. */
function snapshot(row: SubscriptionExemption): Prisma.InputJsonValue {
  return { name: row.name, phone: maskPhone(row.phoneNumber), note: row.note };
}

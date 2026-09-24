import { BadRequestException, Injectable } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsString } from 'class-validator';

import { PrismaService } from '../prisma/prisma.service';

/** Aceita `?accountIds=a,b`, `?accountIds=a&accountIds=b` ou uma lista já pronta. */
function toIdList({ value }: { value: unknown }): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const ids = raw
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

/**
 * Recorte por recurso, comum às listagens e agregações: contas comuns, cartões
 * ou os dois. Nada informado = consolidado (tudo do usuário).
 */
export class ResourceFilterDto {
  @ApiProperty({
    required: false,
    type: [String],
    description: 'Ids de contas comuns (lista separada por vírgula ou parâmetro repetido).',
  })
  @IsOptional()
  @Transform(toIdList)
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  accountIds?: string[];

  @ApiProperty({
    required: false,
    type: [String],
    description: 'Ids de cartões (não da conta interna deles).',
  })
  @IsOptional()
  @Transform(toIdList)
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  cardIds?: string[];
}

/** `null` = consolidado; senão, os `accountId` a que o recorte se limita. */
export type ScopedAccountIds = string[] | null;

/** Filtro Prisma de lançamentos para um recorte já resolvido. */
export function scopeWhere(accountIds: ScopedAccountIds) {
  return accountIds ? { accountId: { in: accountIds } } : {};
}

@Injectable()
export class ResourceScope {
  constructor(private prisma: PrismaService) {}

  /**
   * Converte contas e cartões pedidos nos `accountId` dos lançamentos (no
   * cartão, a conta interna). Id de outro usuário — ou id de cartão passado
   * como conta — responde 400, sem dizer qual: não vaza a existência do recurso.
   */
  async resolve(userId: string, filter: ResourceFilterDto = {}): Promise<ScopedAccountIds> {
    const accountIds = [...new Set(filter.accountIds ?? [])];
    const cardIds = [...new Set(filter.cardIds ?? [])];
    if (accountIds.length === 0 && cardIds.length === 0) return null;

    const [accounts, cards] = await Promise.all([
      accountIds.length
        ? this.prisma.account.findMany({
            where: { id: { in: accountIds }, userId, type: { not: 'credit_card' } },
            select: { id: true },
          })
        : [],
      cardIds.length
        ? this.prisma.creditCard.findMany({
            where: { id: { in: cardIds }, account: { userId } },
            select: { accountId: true },
          })
        : [],
    ]);
    if (accounts.length !== accountIds.length || cards.length !== cardIds.length) {
      throw new BadRequestException('Conta ou cartão inválido');
    }
    return [...accounts.map((a) => a.id), ...cards.map((c) => c.accountId)];
  }
}

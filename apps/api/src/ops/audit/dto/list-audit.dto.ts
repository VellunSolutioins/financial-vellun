import { ApiPropertyOptional } from '@nestjs/swagger';
import { OpsAuditResult } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Filtros da trilha de auditoria.
 *
 * As três perguntas que a trilha responde na prática têm um filtro cada: *quem
 * fez?* (`operatorId`), *o que aconteceu com este item?* (`targetType` +
 * `targetId`) e *o que compôs esta operação?* (`operationId`, que agrupa as
 * linhas de um lote).
 */
export class ListAuditDto {
  @ApiPropertyOptional({ description: 'Operador que praticou a ação.' })
  @IsOptional()
  @IsUUID()
  operatorId?: string;

  @ApiPropertyOptional({ description: 'Ação exata, ex.: `ops.failure.sensitive_viewed`.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  action?: string;

  @ApiPropertyOptional({ description: 'Tipo do alvo, ex.: `ops_failed_message`.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  targetType?: string;

  @ApiPropertyOptional({ description: 'Id do alvo — o histórico de um item só.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  targetId?: string;

  @ApiPropertyOptional({ description: 'Agrupa as linhas de uma mesma operação.' })
  @IsOptional()
  @IsUUID()
  operationId?: string;

  @ApiPropertyOptional({ enum: OpsAuditResult })
  @IsOptional()
  @IsEnum(OpsAuditResult)
  result?: OpsAuditResult;

  @ApiPropertyOptional({ description: 'Início do período (ISO 8601), sobre `createdAt`.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Fim do período (ISO 8601), sobre `createdAt`.' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** 10 por padrão, seguindo a regra do projeto para lista confortável em mobile. */
  @ApiPropertyOptional({ default: 10, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;
}

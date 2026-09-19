import { ApiPropertyOptional } from '@nestjs/swagger';
import { WebhookEventStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Filtros da listagem de eventos de webhook de pagamento.
 *
 * Mesmo desenho da listagem de falhas: todos opcionais, combináveis, e a
 * paginação com o mesmo teto — a investigação começa por um filtro e estreita.
 */
export class ListPaymentsDto {
  @ApiPropertyOptional({ enum: WebhookEventStatus })
  @IsOptional()
  @IsEnum(WebhookEventStatus)
  status?: WebhookEventStatus;

  @ApiPropertyOptional({ description: 'Tipo do evento no PSP, ex.: `PAYMENT_RECEIVED`.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  eventType?: string;

  @ApiPropertyOptional({ description: 'Id do evento no PSP — a busca exata.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  providerEventId?: string;

  @ApiPropertyOptional({ description: 'Início do período (ISO 8601), sobre `receivedAt`.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Fim do período (ISO 8601), sobre `receivedAt`.' })
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

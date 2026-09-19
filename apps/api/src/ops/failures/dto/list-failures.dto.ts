import { ApiPropertyOptional } from '@nestjs/swagger';
import { OpsFailureSource, OpsFailureStatus } from '@prisma/client';
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
 * Filtros da listagem de falhas.
 *
 * Todos opcionais e combináveis: a investigação real começa por um deles
 * (“o que falhou hoje?”, “o que aconteceu com esta correlação?”) e vai
 * estreitando.
 */
export class ListFailuresDto {
  @ApiPropertyOptional({ enum: OpsFailureStatus })
  @IsOptional()
  @IsEnum(OpsFailureStatus)
  status?: OpsFailureStatus;

  @ApiPropertyOptional({ enum: OpsFailureSource, description: 'De qual DLQ a falha veio.' })
  @IsOptional()
  @IsEnum(OpsFailureSource)
  source?: OpsFailureSource;

  @ApiPropertyOptional({ description: 'Nome exato da fila de origem.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  sourceQueue?: string;

  @ApiPropertyOptional({ description: 'Tipo do erro, ex.: `ConnectionError`.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  errorType?: string;

  @ApiPropertyOptional({ description: 'Correlação exata — a ponte para o log.' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  correlationId?: string;

  @ApiPropertyOptional({ description: 'Início do período (ISO 8601), sobre `capturedAt`.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Fim do período (ISO 8601), sobre `capturedAt`.' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /**
   * 10 por padrão, seguindo a regra do projeto para lista confortável em mobile.
   * O teto de 50 existe para que um filtro largo não vire uma varredura.
   */
  @ApiPropertyOptional({ default: 10, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;
}

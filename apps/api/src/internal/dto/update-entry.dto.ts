import { Type } from 'class-transformer';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Correção de um lançamento pelo agente de WhatsApp (docs/plans/018, Fase 3).
 * Só o que uma conversa corrige: valor, data, categoria, conta e descrição.
 * Tipo e status ficam de fora — trocar despesa por receita ou cancelar é no app.
 */
export class UpdateEntryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount?: number;

  @IsOptional()
  @IsDateString()
  transactionDate?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  description?: string;
}

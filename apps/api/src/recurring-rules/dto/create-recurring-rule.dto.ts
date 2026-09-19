import { ApiProperty } from '@nestjs/swagger';
import { RecurringFrequency, TransactionType } from '@prisma/client';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class CreateRecurringRuleDto {
  @ApiProperty({ enum: ['income', 'expense'], description: 'Receita ou despesa fixa.' })
  @IsIn(['income', 'expense'])
  type!: Extract<TransactionType, 'income' | 'expense'>;

  @ApiProperty()
  @IsString()
  description!: string;

  @ApiProperty({ description: 'Valor nominal da regra, ex.: 2400.00.' })
  @IsNumber()
  @IsPositive()
  amount!: number;

  @ApiProperty()
  @IsUUID()
  accountId!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({ enum: RecurringFrequency, default: RecurringFrequency.monthly })
  @IsIn(Object.values(RecurringFrequency))
  frequency!: RecurringFrequency;

  @ApiProperty({ minimum: 1, maximum: 28, description: 'Dia do mês em que vence.' })
  @IsInt()
  @Min(1)
  @Max(28)
  dueDay!: number;

  @ApiProperty({ description: 'Data (YYYY-MM-DD) a partir de quando a regra passa a valer.' })
  @IsDateString()
  startDate!: string;

  @ApiProperty({ required: false, description: 'Data (YYYY-MM-DD) opcional de encerramento.' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

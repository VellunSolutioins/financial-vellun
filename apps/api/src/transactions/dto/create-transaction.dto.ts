import { IsInt, Max, Min } from 'class-validator';
import { RecurrenceType } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ENTRY_TYPES, EntryType } from '../entry-types';

export class CreateTransactionDto {
  @ApiProperty({ enum: ENTRY_TYPES })
  @IsIn(ENTRY_TYPES)
  type!: EntryType;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  amount!: number;

  @ApiProperty()
  @IsString()
  description!: string;

  @ApiProperty()
  @IsString()
  accountId!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiProperty()
  @IsDateString()
  transactionDate!: string;

  @ApiProperty({
    enum: RecurrenceType,
    default: RecurrenceType.avulso,
    required: false,
    description: 'Recorrência: avulso (única vez), fixo (repete todo mês) ou parcelado.',
  })
  @IsOptional()
  @IsEnum(RecurrenceType)
  recurrenceType?: RecurrenceType;

  @ApiProperty({
    required: false,
    description:
      'Número de parcelas — obrigatório quando recurrenceType = parcelado (mínimo 2, máximo 72).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(72)
  installments?: number;

  @ApiProperty({
    required: false,
    description:
      'Quantidade de meses a gerar — obrigatório quando recurrenceType = fixo (mínimo 2, máximo 120).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(120)
  recurrenceMonths?: number;
}

import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { RecurrenceType, TransactionStatus, TransactionType } from '@prisma/client';
import { Type } from 'class-transformer';

export class CreateTransactionDto {
  @ApiProperty({ enum: TransactionType })
  @IsEnum(TransactionType)
  type!: TransactionType;

  @ApiProperty({
    description:
      'Em `avulso` e `fixo`, o valor de cada lançamento. Em `parcelado`, o valor ' +
      'TOTAL da compra — o backend divide por `installments` e a última parcela ' +
      'absorve os centavos da sobra.',
  })
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

  @ApiProperty({ enum: TransactionStatus, default: TransactionStatus.confirmed })
  @IsOptional()
  @IsEnum(TransactionStatus)
  status?: TransactionStatus;

  @ApiProperty({ enum: RecurrenceType, default: RecurrenceType.avulso, required: false })
  @IsOptional()
  @IsEnum(RecurrenceType)
  recurrenceType?: RecurrenceType;

  @ApiProperty({
    required: false,
    description: 'Número de parcelas — obrigatório quando recurrenceType = parcelado (mínimo 2, máximo 72).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(72)
  installments?: number;

  @ApiProperty({
    required: false,
    description: 'Quantidade de meses a gerar — obrigatório quando recurrenceType = fixo (mínimo 2, máximo 120).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(120)
  recurrenceMonths?: number;
}

import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { RecurrenceType, TransactionStatus, TransactionType } from '@prisma/client';
import { Type } from 'class-transformer';

export class CreateTransactionDto {
  @ApiProperty({ enum: TransactionType })
  @IsEnum(TransactionType)
  type!: TransactionType;

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
    description: 'Número de parcelas — obrigatório quando recurrenceType = parcelado (mínimo 2).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  installments?: number;

  @ApiProperty({
    required: false,
    description: 'Quantidade de meses a gerar — obrigatório quando recurrenceType = fixo (mínimo 2).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  recurrenceMonths?: number;
}

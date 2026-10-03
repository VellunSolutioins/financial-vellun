import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TransactionStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { ENTRY_TYPES, EntryType } from '../entry-types';

export class UpdateTransactionDto {
  @ApiProperty({ enum: ENTRY_TYPES, required: false })
  @IsOptional()
  @IsIn(ENTRY_TYPES)
  type?: EntryType;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  amount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  accountId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  transactionDate?: string;

  @ApiProperty({
    required: false,
    description: 'Data do fato. Na parcela, só muda pela compra (Parcelamentos).',
  })
  @IsOptional()
  @IsDateString()
  eventDate?: string;

  @ApiProperty({
    required: false,
    description: 'Previsão (verdadeiro) ou obrigação firmada (falso).',
  })
  @IsOptional()
  @IsBoolean()
  forecast?: boolean;

  @ApiProperty({ enum: TransactionStatus, required: false })
  @IsOptional()
  @IsEnum(TransactionStatus)
  status?: TransactionStatus;
}

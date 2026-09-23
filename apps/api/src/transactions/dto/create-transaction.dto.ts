import { IsDateString, IsEnum, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TransactionStatus, TransactionType } from '@prisma/client';
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
}

import { IsDateString, IsEnum, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TransactionStatus, TransactionType } from '@prisma/client';
import { Type } from 'class-transformer';

export class UpdateTransactionDto {
  @ApiProperty({ enum: TransactionType, required: false })
  @IsOptional()
  @IsEnum(TransactionType)
  type?: TransactionType;

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
  categoryId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  transactionDate?: string;

  @ApiProperty({ enum: TransactionStatus, required: false })
  @IsOptional()
  @IsEnum(TransactionStatus)
  status?: TransactionStatus;
}

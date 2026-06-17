import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TransactionSource, TransactionStatus, TransactionType } from '@prisma/client';
import { Type } from 'class-transformer';

export class ListTransactionsDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  periodStart?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  periodEnd?: string;

  @ApiProperty({ enum: TransactionType, required: false })
  @IsOptional()
  @IsEnum(TransactionType)
  type?: TransactionType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  accountId?: string;

  @ApiProperty({ enum: TransactionStatus, required: false })
  @IsOptional()
  @IsEnum(TransactionStatus)
  status?: TransactionStatus;

  @ApiProperty({ enum: TransactionSource, required: false })
  @IsOptional()
  @IsEnum(TransactionSource)
  source?: TransactionSource;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ default: 1, required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ default: 20, required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;

  @ApiProperty({ default: 'transactionDate', required: false })
  @IsOptional()
  @IsString()
  sortBy?: string = 'transactionDate';

  @ApiProperty({ enum: ['asc', 'desc'], default: 'desc', required: false })
  @IsOptional()
  @IsEnum(['asc', 'desc'])
  order?: 'asc' | 'desc' = 'desc';
}

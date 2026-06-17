import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';
import { TransactionType, TransactionStatus } from '@prisma/client';

export class CreateAiTransactionDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsString()
  @IsNotEmpty()
  accountId!: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsEnum(TransactionType)
  type!: TransactionType;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsString()
  @IsNotEmpty()
  transactionDate!: string;

  @IsOptional()
  @IsEnum(TransactionStatus)
  status?: TransactionStatus;

  @IsOptional()
  @IsEnum(['ai', 'whatsapp'])
  source?: 'ai' | 'whatsapp';

  @IsOptional()
  @IsString()
  rawInput?: string;

  @IsOptional()
  @IsString()
  aiExtractedTransactionId?: string;
}

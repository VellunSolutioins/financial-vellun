import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
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

  /**
   * Chave de idempotência da origem (o `jobId` do pipeline do WhatsApp).
   * Reenvio com a mesma chave devolve o lançamento já criado, em vez de
   * duplicar — cobre o timeout que acontece *depois* da criação.
   */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  idempotencyKey?: string;
}

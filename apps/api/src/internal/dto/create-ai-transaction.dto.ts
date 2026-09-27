import {
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';
import { TransactionStatus } from '@prisma/client';
import { ENTRY_TYPES, EntryType } from '../../transactions/entry-types';

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

  @IsIn(ENTRY_TYPES)
  type!: EntryType;

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

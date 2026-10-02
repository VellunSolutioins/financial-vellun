import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { RecurrenceFrequency, RecurrenceType, TransactionStatus } from '@prisma/client';
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

  /** No parcelado, o valor TOTAL da compra (a API divide); no fixo, o de cada ocorrência. */
  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsString()
  @IsNotEmpty()
  description!: string;

  /** Data da (primeira) ocorrência, só a data: `YYYY-MM-DD`. */
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'transactionDate deve estar no formato YYYY-MM-DD' })
  transactionDate!: string;

  @IsOptional()
  @IsEnum(TransactionStatus)
  status?: TransactionStatus;

  /**
   * Já foi pago/recebido ("gastei", "paguei", "recebi") ou fica em aberto
   * ("vence dia 10", "vou receber"). Ausente: mesmo padrão do formulário —
   * avulso em conta comum com data até hoje nasce pago. Ignorado no cartão
   * (a compra é paga pela fatura) e em data futura (nada foi pago ainda).
   */
  @IsOptional()
  @IsBoolean()
  settle?: boolean;

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

  /** Mesma regra do formulário: avulso (única vez), fixo (repete) ou parcelado. */
  @IsOptional()
  @IsEnum(RecurrenceType)
  recurrenceType?: RecurrenceType;

  /** Só no fixo; padrão mensal. */
  @IsOptional()
  @IsEnum(RecurrenceFrequency)
  recurrenceFrequency?: RecurrenceFrequency;

  /** Número de parcelas — obrigatório no parcelado. */
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(72)
  installments?: number;

  /** Quantidade de ocorrências — obrigatório no fixo. */
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(120)
  recurrenceMonths?: number;
}

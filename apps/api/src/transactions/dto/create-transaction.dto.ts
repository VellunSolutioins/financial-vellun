import { IsBoolean, IsInt, Length, Max, Min } from 'class-validator';
import { RecurrenceFrequency, RecurrenceType } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ENTRY_TYPES, EntryType } from '../entry-types';

export class CreateTransactionDto {
  @ApiProperty({ enum: ENTRY_TYPES })
  @IsIn(ENTRY_TYPES)
  type!: EntryType;

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

  @ApiProperty({
    description:
      'Data da (primeira) ocorrência: vencimento ou previsão. No parcelado, a data da compra e da parcela 1.',
  })
  @IsDateString()
  transactionDate!: string;

  @ApiProperty({
    required: false,
    description:
      'Data do fato, quando difere do vencimento (ex.: consumo de setembro que vence em outubro). ' +
      'Padrão: a própria data do lançamento. Ignorada no cartão e no fixo.',
  })
  @IsOptional()
  @IsDateString()
  eventDate?: string;

  @ApiProperty({
    required: false,
    description:
      'Já foi pago/recebido: grava a liquidação junto. Padrão: avulso em conta comum com data até hoje. ' +
      'Ignorado no cartão (a compra é paga pela fatura). Não vale para data futura.',
  })
  @IsOptional()
  @IsBoolean()
  settle?: boolean;

  @ApiProperty({
    required: false,
    description:
      'Previsão em vez de conta a pagar ou a receber. Padrão: falso. Só faz diferença na ' +
      'recorrência (fixo) em conta comum; no cartão, o que separa previsão de cobrança é a data.',
  })
  @IsOptional()
  @IsBoolean()
  forecast?: boolean;

  @ApiProperty({
    required: false,
    description:
      'Chave única por tentativa (a tela gera uma por abertura do formulário). Repetir devolve o lançamento já criado.',
  })
  @IsOptional()
  @IsString()
  @Length(8, 100)
  idempotencyKey?: string;

  @ApiProperty({
    enum: RecurrenceType,
    default: RecurrenceType.avulso,
    required: false,
    description: 'Recorrência: avulso (única vez), fixo (repete) ou parcelado.',
  })
  @IsOptional()
  @IsEnum(RecurrenceType)
  recurrenceType?: RecurrenceType;

  @ApiProperty({
    enum: RecurrenceFrequency,
    default: RecurrenceFrequency.monthly,
    required: false,
    description: 'Frequência das ocorrências quando recurrenceType = fixo.',
  })
  @IsOptional()
  @IsEnum(RecurrenceFrequency)
  recurrenceFrequency?: RecurrenceFrequency;

  @ApiProperty({
    required: false,
    description:
      'Número de parcelas — obrigatório quando recurrenceType = parcelado (mínimo 2, máximo 72).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(72)
  installments?: number;

  @ApiProperty({
    required: false,
    description:
      'Quantidade de ocorrências a gerar — obrigatório quando recurrenceType = fixo (mínimo 2, ' +
      'máximo 120). No mensal, equivale ao número de meses.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(120)
  recurrenceMonths?: number;
}

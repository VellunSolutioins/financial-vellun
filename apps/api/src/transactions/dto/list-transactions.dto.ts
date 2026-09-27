import { RecurrenceType } from '@prisma/client';
import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TransactionSource, TransactionStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { ENTRY_TYPES, EntryType } from '../entry-types';

export class ListTransactionsDto {
  @IsOptional()
  @IsEnum(RecurrenceType)
  recurrenceType?: RecurrenceType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  periodStart?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  periodEnd?: string;

  @ApiProperty({ enum: ENTRY_TYPES, required: false })
  @IsOptional()
  @IsIn(ENTRY_TYPES)
  type?: EntryType;

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

  /**
   * 10 por página, a regra de leitura confortável em mobile do CLAUDE.md. Era
   * 20: o dobro de linhas por página e o dobro de trabalho por request, para
   * uma tela que em celular já exigia rolagem na metade disso.
   *
   * O teto existe porque o parâmetro é público: sem ele, `?limit=1000000` é uma
   * varredura da tabela inteira por request. 500 é o que a tela de contas a
   * pagar/receber pede hoje (`PendingTransactionsView`), então o teto não muda
   * nada que já funciona — só fecha a porta do abuso.
   */
  @ApiProperty({ default: 10, maximum: 500, required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number = 10;

  @ApiProperty({ default: 'transactionDate', required: false })
  @IsOptional()
  @IsString()
  sortBy?: string = 'transactionDate';

  @ApiProperty({ enum: ['asc', 'desc'], default: 'desc', required: false })
  @IsOptional()
  @IsEnum(['asc', 'desc'])
  order?: 'asc' | 'desc' = 'desc';
}

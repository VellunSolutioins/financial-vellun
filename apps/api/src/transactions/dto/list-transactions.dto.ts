import { RecurrenceType } from '@prisma/client';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TransactionSource, TransactionStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { SettlementFilter } from '../settlement-state';

const SETTLEMENT_FILTERS = [
  'open',
  'partial',
  'settled',
  'overdue',
  'forecast',
] as const satisfies readonly SettlementFilter[];
import { ENTRY_TYPES, EntryType } from '../entry-types';
import { ResourceFilterDto } from '../../common/resource-scope';

/**
 * Filtros de lançamentos, sem paginação. A listagem e os totais
 * (`GET /transactions/summary`) usam exatamente os mesmos.
 */
export class TransactionFiltersDto extends ResourceFilterDto {
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

  @ApiProperty({
    enum: SETTLEMENT_FILTERS,
    required: false,
    description:
      'Estado de liquidação (conta comum): em aberto, parcial, liquidado, vencido (em aberto com vencimento passado) ou previsão.',
  })
  @IsOptional()
  @IsIn(SETTLEMENT_FILTERS)
  settlement?: SettlementFilter;

  @ApiProperty({ required: false, description: 'Só previsões (true) ou só obrigações (false).' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  forecast?: boolean;

  @ApiProperty({
    enum: ['due', 'event', 'spending'],
    default: 'due',
    required: false,
    description:
      'A que data o período se aplica: `due` = vencimento/ocorrência (na parcela, a data dela); ' +
      '`event` = data do fato (na parcela, a data da compra); `spending` = mês do gasto, como no ' +
      'dashboard (a parcela no mês dela, o resto na data do fato).',
  })
  @IsOptional()
  @IsIn(['due', 'event', 'spending'])
  dateBasis?: 'due' | 'event' | 'spending';

  @ApiProperty({
    required: false,
    description:
      'Só gastos realizados (fato até hoje, sem previsão ainda não paga): o mesmo critério do dashboard.',
  })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  realizedOnly?: boolean;
}

export class ListTransactionsDto extends TransactionFiltersDto {
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

import { IsDateString, IsOptional, Matches } from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Período do resumo pedido pelo agente. Sem ele, o mês corrente. */
export class SummaryQueryDto {
  @IsOptional()
  @Matches(DATE_ONLY)
  @IsDateString()
  periodStart?: string;

  @IsOptional()
  @Matches(DATE_ONLY)
  @IsDateString()
  periodEnd?: string;
}

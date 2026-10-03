import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsNumber, IsOptional, Min } from 'class-validator';

/**
 * Posição do cartão no início do controle: o que já se devia (a fatura
 * anterior ainda não paga) e o crédito que havia. Não é despesa: as compras
 * que formaram essa dívida aconteceram antes do controle (docs/adrs/0018).
 * Zero nos dois remove a posição inicial.
 */
export class OpeningPositionDto {
  @ApiProperty({
    required: false,
    description:
      'Valor ainda não pago da fatura anterior ao início do controle (R$). Zero ou ausente: sem dívida anterior.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  previousInvoiceAmount?: number;

  @ApiProperty({
    required: false,
    description:
      'Vencimento dessa fatura (YYYY-MM-DD). Padrão: o vencimento que a configuração dá para o ciclo que fechou no início do controle.',
  })
  @IsOptional()
  @IsDateString()
  previousInvoiceDueDate?: string;

  @ApiProperty({
    required: false,
    description: 'Crédito que o cartão tinha no início do controle (R$).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  credit?: number;
}

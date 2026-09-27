import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsNumber, IsOptional, IsPositive } from 'class-validator';

export const REFUND_SCOPES = ['single', 'series'] as const;
export type RefundScope = (typeof REFUND_SCOPES)[number];

export class RefundTransactionDto {
  @ApiProperty({
    required: false,
    description:
      'Valor estornado (obrigatório em `single`). A soma dos estornos não passa da compra.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount?: number;

  @ApiProperty({
    description: 'YYYY-MM-DD. No cartão, o estorno entra na fatura aberta nesta data.',
  })
  @IsDateString()
  date!: string;

  @ApiProperty({
    enum: REFUND_SCOPES,
    default: 'single',
    required: false,
    description:
      '`series` (compra parcelada): cancela as parcelas ainda não faturadas e estorna, por ' +
      'inteiro, as já faturadas.',
  })
  @IsOptional()
  @IsIn(REFUND_SCOPES)
  scope?: RefundScope;
}

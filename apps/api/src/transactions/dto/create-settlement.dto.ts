import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Length,
} from 'class-validator';

export const SETTLEMENT_KINDS = ['payment', 'write_off'] as const;

/** Pagamento, recebimento ou dispensa do restante de um lançamento de conta comum. */
export class CreateSettlementDto {
  @ApiProperty({
    required: false,
    description:
      'Valor pago ou recebido. Sem ele, liquida o restante. Não passa do que falta: liquidação parcial é permitida, excedente não.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount?: number;

  @ApiProperty({ description: 'Data do pagamento/recebimento (YYYY-MM-DD); não pode ser futura.' })
  @IsDateString()
  date!: string;

  @ApiProperty({
    required: false,
    description:
      'Conta comum de onde saiu ou para onde entrou o dinheiro. Padrão: a conta do lançamento. Ignorada na dispensa.',
  })
  @IsOptional()
  @IsString()
  accountId?: string;

  @ApiProperty({
    enum: SETTLEMENT_KINDS,
    required: false,
    default: 'payment',
    description:
      '`payment` move dinheiro. `write_off` dispensa o restante (desconto, perdão, cobrança que não vai acontecer) sem mexer no saldo.',
  })
  @IsOptional()
  @IsIn(SETTLEMENT_KINDS)
  kind?: (typeof SETTLEMENT_KINDS)[number];

  @ApiProperty({
    description:
      'Chave única por tentativa (a tela gera uma por abertura do diálogo). Repetir a chave devolve a mesma liquidação em vez de pagar de novo.',
  })
  @IsString()
  @Length(8, 100)
  idempotencyKey!: string;
}

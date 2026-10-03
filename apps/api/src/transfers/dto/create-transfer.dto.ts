import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Transferência entre contas próprias. O tipo das contas diz o que ela é:
 * conta → investimento é aporte; investimento → conta, resgate; empréstimo →
 * conta, empréstimo recebido; conta → empréstimo, amortização. Nunca é
 * receita nem despesa.
 */
export class CreateTransferDto {
  @ApiProperty({ description: 'Conta comum de onde o dinheiro sai.' })
  @IsString()
  fromAccountId!: string;

  @ApiProperty({ description: 'Conta comum para onde o dinheiro vai.' })
  @IsString()
  toAccountId!: string;

  @ApiProperty({ description: 'Valor transferido (o principal, num empréstimo).' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @ApiProperty({ description: 'YYYY-MM-DD; não pode ser futura (registra o que já aconteceu).' })
  @IsDateString()
  date!: string;

  @ApiProperty({ required: false, description: 'Padrão: o nome do tipo (Aporte, Resgate…).' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiProperty({
    required: false,
    description:
      'Juros ou tarifa pagos junto (R$). Vira uma despesa à parte, já paga, na conta comum que paga — ' +
      'separada do principal, que não é despesa.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  feeAmount?: number;

  @ApiProperty({
    required: false,
    description: 'Categoria da despesa de juros/tarifa. Padrão: "Juros e tarifas".',
  })
  @IsOptional()
  @IsString()
  feeCategoryId?: string;

  @ApiProperty({
    description:
      'Chave única por tentativa (a tela gera uma por abertura do diálogo). Repetir devolve a mesma transferência.',
  })
  @IsString()
  @Length(8, 100)
  idempotencyKey!: string;
}

export class ListTransfersDto {
  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

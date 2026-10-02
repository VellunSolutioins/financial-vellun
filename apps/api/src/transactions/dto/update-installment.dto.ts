import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/** Alterações aplicadas a todas as parcelas da compra. */
export class UpdateInstallmentDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  description?: string;

  @ApiProperty({ required: false, description: 'Vazio remove a categoria' })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiProperty({
    required: false,
    description:
      'Data da compra (YYYY-MM-DD): a data do fato de todas as parcelas. No cartão, só enquanto ' +
      'nenhuma parcela estiver em fatura fechada ou paga — ela decide as faturas.',
  })
  @IsOptional()
  @IsDateString()
  purchaseDate?: string;
}

export class DeleteInstallmentQueryDto {
  @ApiProperty({
    enum: ['all', 'future'],
    default: 'all',
    required: false,
    description: '`all`: a compra inteira; `future`: as parcelas de hoje em diante.',
  })
  @IsOptional()
  @IsIn(['all', 'future'])
  scope?: 'all' | 'future' = 'all';
}

/** Adiantamento das últimas parcelas da compra para hoje (fatura aberta, no cartão). */
export class AdvanceInstallmentDto {
  @ApiProperty({
    description: 'Quantas parcelas adiantar, a partir da última. Máximo: `advanceable.length`.',
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  count!: number;

  @ApiProperty({
    required: false,
    description:
      'Total a pagar pelas parcelas adiantadas, com desconto. Não passa da soma delas; ' +
      'é rateado entre as parcelas proporcionalmente. Sem ele, o valor não muda.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount?: number;

  @ApiProperty({
    required: false,
    description:
      'Número da última parcela ainda não adiantada, como o cliente a viu (`advanceable[0]`). ' +
      'Se mudou — o mesmo pedido já foi aplicado —, responde 409 e não adianta nada.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  expectedLastNumber?: number;
}

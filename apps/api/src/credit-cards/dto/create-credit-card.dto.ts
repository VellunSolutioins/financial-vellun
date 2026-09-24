import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, IsPositive, IsString, Max, Min } from 'class-validator';

export class CreateCreditCardDto {
  @ApiProperty({ description: 'Nome do cartão, ex.: "Nubank Roxo".' })
  @IsString()
  name!: string;

  @ApiProperty({ required: false, description: 'Ex.: Mastercard, Visa.' })
  @IsOptional()
  @IsString()
  brand?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  color?: string | null;

  @ApiProperty({ required: false, description: 'Limite de gasto. Omitir = sem limite definido.' })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  creditLimit?: number | null;

  @ApiProperty({
    minimum: 1,
    maximum: 31,
    description: 'Dia do fechamento da fatura; nos meses curtos, o último dia.',
  })
  @IsInt()
  @Min(1)
  @Max(31)
  closingDay!: number;

  @ApiProperty({
    minimum: 1,
    maximum: 31,
    description: 'Dia do vencimento da fatura; nos meses curtos, o último dia.',
  })
  @IsInt()
  @Min(1)
  @Max(31)
  dueDay!: number;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Conta comum sugerida para pagar a fatura (só sugestão).',
  })
  @IsOptional()
  @IsString()
  paymentAccountId?: string | null;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, IsPositive, IsString, Max, Min } from 'class-validator';

export class CreateCreditCardDto {
  @ApiProperty({ description: 'Nome do cartão, ex.: "Nubank Roxo".' })
  @IsString()
  name!: string;

  @ApiProperty({ required: false, description: 'Ex.: Mastercard, Visa.' })
  @IsOptional()
  @IsString()
  brand?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiProperty({ required: false, description: 'Limite de gasto. Omitir = sem limite definido.' })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  creditLimit?: number;

  @ApiProperty({ minimum: 1, maximum: 28 })
  @IsInt()
  @Min(1)
  @Max(28)
  dueDay!: number;
}

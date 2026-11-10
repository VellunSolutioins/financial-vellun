import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

/** Alterações aplicadas às ocorrências da recorrência de hoje em diante. */
export class UpdateRecurrenceDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  amount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  accountId?: string;

  @ApiProperty({ required: false, description: 'Vazio remove a categoria' })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiProperty({
    required: false,
    minimum: 1,
    maximum: 31,
    description: 'Dia de vencimento; nos meses curtos, cai no último dia.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  dueDay?: number;

  @ApiProperty({
    required: false,
    description:
      'Obsoleto e ignorado: as ocorrências de um gasto fixo são sempre previsão. ' +
      'Aceito só para compatibilidade com clientes antigos.',
  })
  @IsOptional()
  @IsBoolean()
  forecast?: boolean;
}

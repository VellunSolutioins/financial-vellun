import { IsOptional, IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

import { IsCnpj } from '../../common/validators/is-document.validator';

export class CreateBusinessProfileDto {
  @ApiProperty()
  @IsString()
  companyName!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  tradeName?: string;

  @ApiProperty({ example: '12.345.678/0001-99' })
  @IsString()
  @Matches(/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/, {
    message: 'CNPJ inválido (formato: 00.000.000/0000-00)',
  })
  @IsCnpj({ message: 'CNPJ inválido (dígito verificador)' })
  cnpj!: string;
}

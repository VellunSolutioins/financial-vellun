import { IsDateString, IsOptional, IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

import { IsCpf } from '../../common/validators/is-document.validator';

export class CreateIndividualProfileDto {
  @ApiProperty({ example: '123.456.789-09' })
  @IsString()
  @Matches(/^\d{3}\.\d{3}\.\d{3}-\d{2}$/, { message: 'CPF inválido (formato: 000.000.000-00)' })
  @IsCpf({ message: 'CPF inválido (dígito verificador)' })
  cpf!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  birthDate?: string;
}

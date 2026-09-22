import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateUserDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'Nome não pode ser vazio' })
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsEmail({}, { message: 'Email inválido' })
  email?: string;

  @ApiProperty({
    required: false,
    description: 'Senha atual. Obrigatória quando o e-mail muda.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  currentPassword?: string;

  // ── Endereço de cobrança (opcional na edição) ──
  @ApiProperty({ required: false, example: '80240-000' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{5}-?\d{3}$/, { message: 'CEP inválido (formato: 00000-000)' })
  postalCode?: string;

  @ApiProperty({ required: false, example: 'Rua das Flores' })
  @IsOptional()
  @IsString()
  street?: string;

  @ApiProperty({ required: false, example: '123' })
  @IsOptional()
  @IsString()
  addressNumber?: string;

  @ApiProperty({ required: false, example: 'Apto 45' })
  @IsOptional()
  @IsString()
  complement?: string;

  @ApiProperty({ required: false, example: 'Centro' })
  @IsOptional()
  @IsString()
  neighborhood?: string;

  @ApiProperty({ required: false, example: 'Curitiba' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiProperty({ required: false, example: 'PR' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/, { message: 'UF inválida (2 letras, ex.: PR)' })
  state?: string;
}

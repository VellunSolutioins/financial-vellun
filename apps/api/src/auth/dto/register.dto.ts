import { IsDateString, IsEmail, IsEnum, IsOptional, IsString, Matches, MinLength, ValidateIf } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ProfileType } from '@prisma/client';

export class RegisterDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty({ example: '(19) 99999-9999' })
  @IsString()
  @Matches(/^\(\d{2}\) \d{4,5}-\d{4}$/, {
    message: 'Celular inválido (formato: (00) 00000-0000)',
  })
  phone!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiProperty({ enum: ProfileType })
  @IsEnum(ProfileType)
  profileType!: ProfileType;

  // ── Pessoa Física (obrigatório quando profileType = individual) ──
  @ApiProperty({ example: '123.456.789-09', required: false })
  @ValidateIf((o) => o.profileType === ProfileType.individual)
  @IsString()
  @Matches(/^\d{3}\.\d{3}\.\d{3}-\d{2}$/, { message: 'CPF inválido (formato: 000.000.000-00)' })
  cpf?: string;

  @ApiProperty({ required: false })
  @ValidateIf((o) => o.profileType === ProfileType.individual)
  @IsOptional()
  @IsDateString()
  birthDate?: string;

  // ── Pessoa Jurídica (obrigatório quando profileType = business) ──
  @ApiProperty({ required: false })
  @ValidateIf((o) => o.profileType === ProfileType.business)
  @IsString()
  companyName?: string;

  @ApiProperty({ required: false })
  @ValidateIf((o) => o.profileType === ProfileType.business)
  @IsOptional()
  @IsString()
  tradeName?: string;

  @ApiProperty({ example: '12.345.678/0001-99', required: false })
  @ValidateIf((o) => o.profileType === ProfileType.business)
  @IsString()
  @Matches(/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/, { message: 'CNPJ inválido (formato: 00.000.000/0000-00)' })
  cnpj?: string;
}

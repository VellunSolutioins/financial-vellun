import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class StartPhoneVerificationDto {
  @ApiProperty({
    required: false,
    example: '(11) 99999-9999',
    description: 'Número a verificar. Sem ele, usa o telefone do cadastro.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\(\d{2}\) \d{4,5}-\d{4}$/, {
    message: 'Telefone inválido (formato: (00) 00000-0000)',
  })
  phone?: string;

  @ApiProperty({
    required: false,
    description: 'Senha atual. Obrigatória para trocar um número já verificado.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  currentPassword?: string;
}

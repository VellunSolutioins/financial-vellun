import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const PHONE_REGEX = /^\(\d{2}\) \d{4,5}-\d{4}$/;
const PHONE_MESSAGE = 'WhatsApp inválido: use (00) 00000-0000.';

export class CreateExemptionDto {
  @ApiProperty({ example: 'Maria Souza' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiProperty({ description: 'WhatsApp mascarado.', example: '(41) 99999-9999' })
  @Matches(PHONE_REGEX, { message: PHONE_MESSAGE })
  phone!: string;

  @ApiPropertyOptional({
    description: 'Por que o número é isento. Vai para a auditoria como justificativa.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class UpdateExemptionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ example: '(41) 99999-9999' })
  @IsOptional()
  @Matches(PHONE_REGEX, { message: PHONE_MESSAGE })
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class DeleteExemptionDto {
  @ApiProperty({ description: 'Justificativa registrada na auditoria.' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

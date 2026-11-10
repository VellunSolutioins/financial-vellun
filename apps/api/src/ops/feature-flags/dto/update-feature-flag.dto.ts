import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateFeatureFlagDto {
  @ApiProperty({
    description: 'Disponível (`true`) ou indisponível (`false`) para todos os usuários.',
  })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({
    description:
      'Justificativa registrada na auditoria. Obrigatória: desligar uma funcionalidade afeta todos os clientes.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

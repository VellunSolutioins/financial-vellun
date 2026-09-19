import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OpsRole } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateOperatorDto {
  @ApiPropertyOptional({ enum: OpsRole })
  @IsOptional()
  @IsEnum(OpsRole)
  role?: OpsRole;

  @ApiPropertyOptional({ description: 'Ativa ou desativa o acesso do operador.' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({
    description: 'Permite ver telefone e conteúdo de mensagem em claro.',
  })
  @IsOptional()
  @IsBoolean()
  canViewSensitive?: boolean;

  @ApiProperty({
    description:
      'Justificativa registrada na auditoria. Obrigatória: conceder acesso é uma decisão, e a trilha precisa saber por quê.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

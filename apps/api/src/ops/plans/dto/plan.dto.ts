import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BillingInterval } from '@prisma/client';
import {
  IsBoolean,
  IsDecimal,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Justificativa de toda escrita em plano: muda o que o cliente vê e paga. */
class PlanReasonDto {
  @ApiProperty({ description: 'Justificativa registrada na auditoria.' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class CreatePlanDto extends PlanReasonDto {
  @ApiProperty({
    description:
      'Identificador estável (letras minúsculas, números e hífen). Não muda depois de criado.',
    example: 'zeloo-mensal',
  })
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'Código: só letras minúsculas, números e hífen (ex.: zeloo-mensal).',
  })
  @MaxLength(60)
  code!: string;

  @ApiProperty({ example: 'Zeloo Mensal' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ example: 'Acesso completo ao Zeloo.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @ApiProperty({ description: 'Preço em reais, ponto decimal.', example: '49.90' })
  @IsDecimal({ decimal_digits: '0,2' }, { message: 'Preço inválido.' })
  price!: string;

  @ApiProperty({ enum: BillingInterval })
  @IsEnum(BillingInterval)
  interval!: BillingInterval;

  @ApiProperty({
    description:
      'Exibir na tela de assinatura. Oculto, o plano não aceita checkout novo; quem já assina segue normalmente.',
  })
  @IsBoolean()
  isActive!: boolean;
}

export class UpdatePlanDto extends PlanReasonDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @ApiPropertyOptional({
    description: 'Vale para checkouts novos: assinaturas já criadas mantêm o valor.',
  })
  @IsOptional()
  @IsDecimal({ decimal_digits: '0,2' }, { message: 'Preço inválido.' })
  price?: string;

  @ApiPropertyOptional({ enum: BillingInterval })
  @IsOptional()
  @IsEnum(BillingInterval)
  interval?: BillingInterval;

  @ApiPropertyOptional({ description: 'Exibir na tela de assinatura.' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class DeletePlanDto extends PlanReasonDto {}

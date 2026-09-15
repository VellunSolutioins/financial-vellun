import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OpsFailureSource } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Envelope da DLQ, como o consumer do catálogo o entrega.
 *
 * Espelha `DlqEnvelopeV1` (`apps/ai-agent/src/messaging/contracts.py`). O agente
 * não fala com o Postgres — ele passa por aqui, como faz para toda persistência.
 */
export class CaptureFailureDto {
  @ApiProperty({ enum: OpsFailureSource })
  @IsEnum(OpsFailureSource)
  source!: OpsFailureSource;

  @ApiProperty()
  @IsString()
  @MaxLength(200)
  sourceQueue!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(200)
  routingKey!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  correlationId?: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  attempts!: number;

  @ApiProperty()
  @IsString()
  @MaxLength(200)
  errorType!: string;

  @ApiProperty({ description: 'Já truncado em 500 caracteres pelo agente.' })
  @IsString()
  @MaxLength(2000)
  errorMessage!: string;

  @ApiProperty()
  @IsBoolean()
  permanent!: boolean;

  @ApiProperty({ description: 'Mensagem original, íntegra — é o que será republicado.' })
  @IsObject()
  payload!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Nulo quando a falha foi permanente na primeira tentativa.' })
  @IsOptional()
  @IsISO8601()
  firstFailedAt?: string;

  @ApiProperty()
  @IsISO8601()
  failedAt!: string;
}

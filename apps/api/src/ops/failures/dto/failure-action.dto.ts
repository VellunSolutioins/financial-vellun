import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Teto de itens por lote.
 *
 * Não é um limite de banco: é o tamanho que ainda cabe numa decisão humana. Um
 * operador consegue olhar o que selecionou e responder por isso; "reprocessar
 * tudo" não é uma decisão, é um gesto.
 */
export const MAX_LOTE = 50;

/**
 * Justificativa obrigatória em toda ação.
 *
 * Reprocessar e descartar são decisões, e a trilha precisa saber por quê. O
 * mínimo de 3 caracteres não impede um "ok" preguiçoso — nada impede — mas
 * torna a ausência de motivo uma escolha explícita, não um campo esquecido.
 */
export class FailureActionDto {
  @ApiProperty({ description: 'Fica registrada na auditoria.', maxLength: 500 })
  @IsString()
  @MinLength(3, { message: 'A justificativa é obrigatória.' })
  @MaxLength(500)
  reason!: string;
}

export class BatchReprocessDto extends FailureActionDto {
  @ApiProperty({ type: [String], maxItems: MAX_LOTE })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LOTE, { message: `No máximo ${MAX_LOTE} falhas por lote.` })
  @IsUUID('4', { each: true })
  ids!: string[];
}

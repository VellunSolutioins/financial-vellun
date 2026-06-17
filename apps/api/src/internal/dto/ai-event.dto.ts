import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { AiExtractionStatus, AiMessageDirection } from '@prisma/client';

/**
 * Evento de auditoria do agente de IA.
 *
 * - `event_type: "message"`  → registra uma mensagem (inbound/outbound) em
 *   `ai_messages`, criando contato + conversa quando necessário.
 * - `event_type: "extraction"` → registra uma extração em
 *   `ai_extracted_transactions`.
 */
export class AiEventDto {
  @IsEnum(['message', 'extraction'])
  eventType!: 'message' | 'extraction';

  // ── message ──────────────────────────────────────────────
  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEnum(AiMessageDirection)
  direction?: AiMessageDirection;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  // ── extraction ───────────────────────────────────────────
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  rawInput?: string;

  @IsOptional()
  @IsObject()
  extractedPayload?: Record<string, unknown>;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number;

  @IsOptional()
  @IsEnum(AiExtractionStatus)
  status?: AiExtractionStatus;

  @IsOptional()
  @IsString()
  transactionId?: string;

  @IsOptional()
  @IsString()
  sourceMessageId?: string;
}

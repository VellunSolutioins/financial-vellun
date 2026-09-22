import { IsString, Matches, MaxLength } from 'class-validator';

/** Payload de `POST /internal/whatsapp/verify`, enviado pelo agente. */
export class ConfirmPhoneVerificationDto {
  /** Número de origem da mensagem, como o webhook da Meta informou. */
  @IsString()
  @MaxLength(32)
  phone!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'code deve ter 6 dígitos' })
  code!: string;
}

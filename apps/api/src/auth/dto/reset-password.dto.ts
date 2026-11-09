import { IsString, Matches, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

import { INVALID_RESET_LINK_MESSAGE } from '../password-reset.service';

export class ResetPasswordDto {
  /** Token do link enviado por e-mail: 32 bytes em hexadecimal. */
  @ApiProperty({ description: 'Token recebido no link do e-mail' })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/, { message: INVALID_RESET_LINK_MESSAGE })
  token!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'A senha deve ter ao menos 8 caracteres' })
  newPassword!: string;
}

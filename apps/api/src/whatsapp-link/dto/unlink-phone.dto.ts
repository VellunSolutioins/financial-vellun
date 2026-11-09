import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class UnlinkPhoneDto {
  @ApiProperty({ description: 'Senha atual. Desvincular o WhatsApp exige confirmá-la.' })
  @IsString()
  @MinLength(1, { message: 'Informe a senha atual' })
  @MaxLength(200)
  currentPassword!: string;
}

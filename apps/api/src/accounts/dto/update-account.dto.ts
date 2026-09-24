import { IsIn, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { REGULAR_ACCOUNT_TYPES, RegularAccountType } from '../account-types';

export class UpdateAccountDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ enum: REGULAR_ACCOUNT_TYPES, required: false })
  @IsOptional()
  @IsIn(REGULAR_ACCOUNT_TYPES, { message: 'Tipo de conta inválido' })
  type?: RegularAccountType;
}

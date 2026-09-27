import { IsIn, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { REGULAR_ACCOUNT_TYPES, RegularAccountType } from '../account-types';

export class CreateAccountDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty({
    enum: REGULAR_ACCOUNT_TYPES,
    description: 'Cartão de crédito não é conta: crie em /credit-cards.',
  })
  @IsIn(REGULAR_ACCOUNT_TYPES, { message: 'Tipo de conta inválido' })
  type!: RegularAccountType;

  @ApiProperty({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  initialBalance?: number;

  @ApiProperty({ default: 'BRL', required: false })
  @IsOptional()
  @IsString()
  currency?: string;
}

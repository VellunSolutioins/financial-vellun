import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';

export class UpdateAccountDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ enum: AccountType, required: false })
  @IsOptional()
  @IsEnum(AccountType)
  type?: AccountType;
}

import { IsEmail, IsEnum, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ProfileType } from '@prisma/client';

export class RegisterDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiProperty({ enum: ProfileType })
  @IsEnum(ProfileType)
  profileType!: ProfileType;
}

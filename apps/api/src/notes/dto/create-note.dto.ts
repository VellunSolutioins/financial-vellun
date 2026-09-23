import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class CreateNoteDto {
  @ApiProperty()
  @IsString()
  title!: string;

  @ApiProperty()
  @IsString()
  content!: string;
}

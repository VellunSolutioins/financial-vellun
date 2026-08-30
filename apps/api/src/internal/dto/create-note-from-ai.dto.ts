import { IsNotEmpty, IsString } from 'class-validator';

import { CreateNoteDto } from '../../notes/dto/create-note.dto';

export class CreateNoteFromAiDto extends CreateNoteDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;
}

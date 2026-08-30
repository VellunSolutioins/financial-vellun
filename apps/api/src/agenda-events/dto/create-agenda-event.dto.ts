import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, Matches } from 'class-validator';

export class CreateAgendaEventDto {
  @ApiProperty({ description: 'Ex.: "Reunião financeira", "Aniversário da Ana".' })
  @IsString()
  title!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty()
  @IsDateString()
  eventDate!: string;

  @ApiProperty({ required: false, description: 'Formato "HH:mm". Omitir = compromisso do dia todo.' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'eventTime deve estar no formato HH:mm' })
  eventTime?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  color?: string;
}

import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

export class CreateReminderDto {
  @ApiProperty({ description: 'Ex.: "Aluguel", "Conta de Luz".' })
  @IsString()
  title!: string;

  @ApiProperty({ required: false, description: 'Omitir para lembrete sem valor definido.' })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  amount?: number;

  @ApiProperty()
  @IsDateString()
  dueDate!: string;

  @ApiProperty({
    default: false,
    description: 'Se true, ao marcar como pago o vencimento rola pro mês seguinte.',
  })
  @IsOptional()
  @IsBoolean()
  isRecurrent?: boolean;

  @ApiProperty({
    required: false,
    description: 'Só usado se isRecurrent=true. Sem ela, repete indefinidamente.',
  })
  @IsOptional()
  @IsDateString()
  recurrenceEndDate?: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class CreateCheckoutDto {
  @ApiProperty({ description: 'ID do plano a contratar' })
  @IsUUID()
  planId!: string;
}

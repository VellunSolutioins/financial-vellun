import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsNumber, IsPositive, IsString, Length } from 'class-validator';

export class CreateCardPaymentDto {
  @ApiProperty({ description: 'Conta comum de onde sai o pagamento.' })
  @IsString()
  sourceAccountId!: string;

  @ApiProperty({
    description: 'Valor pago. Acima do restante, o excedente vira crédito no cartão.',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @ApiProperty({ description: 'YYYY-MM-DD; não pode ser futura.' })
  @IsDateString()
  paymentDate!: string;

  @ApiProperty({
    description:
      'Chave única por tentativa (a tela gera uma por abertura do diálogo). Repetir a chave ' +
      'devolve o mesmo pagamento em vez de pagar de novo.',
  })
  @IsString()
  @Length(8, 100)
  idempotencyKey!: string;
}

import { IsIn } from 'class-validator';

export const OPEN_ITEM_TYPES = ['expense', 'income'] as const;

/** O que o agente quer baixar: contas a pagar (`expense`) ou a receber (`income`). */
export class OpenItemsQueryDto {
  @IsIn(OPEN_ITEM_TYPES)
  type!: (typeof OPEN_ITEM_TYPES)[number];
}

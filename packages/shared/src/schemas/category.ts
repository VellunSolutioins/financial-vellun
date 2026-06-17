import { z } from 'zod';

import { TransactionType } from '../enums';

export const CategorySchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid().nullable(),
  name: z.string().min(1).max(100),
  type: z.enum([TransactionType.INCOME, TransactionType.EXPENSE, TransactionType.TRANSFER]),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Cor deve estar no formato hex #RRGGBB')
    .optional(),
  icon: z.string().max(50).optional(),
  is_default: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export const CreateCategorySchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum([TransactionType.INCOME, TransactionType.EXPENSE, TransactionType.TRANSFER]),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Cor deve estar no formato hex #RRGGBB')
    .optional(),
  icon: z.string().max(50).optional(),
});

export const UpdateCategorySchema = CreateCategorySchema.partial();

export type Category = z.infer<typeof CategorySchema>;
export type CreateCategoryDto = z.infer<typeof CreateCategorySchema>;
export type UpdateCategoryDto = z.infer<typeof UpdateCategorySchema>;

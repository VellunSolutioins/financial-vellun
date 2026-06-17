import { z } from 'zod';

import { TransactionSource, TransactionStatus, TransactionType } from '../enums';

export const TransactionSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  account_id: z.string().uuid(),
  category_id: z.string().uuid().nullable().optional(),
  type: z.enum([TransactionType.INCOME, TransactionType.EXPENSE, TransactionType.TRANSFER]),
  amount: z.number().positive(),
  description: z.string().max(500).optional(),
  transaction_date: z.coerce.date(),
  status: z.enum([
    TransactionStatus.CONFIRMED,
    TransactionStatus.PENDING,
    TransactionStatus.CANCELLED,
  ]),
  source: z.enum([
    TransactionSource.MANUAL,
    TransactionSource.WHATSAPP,
    TransactionSource.AI,
    TransactionSource.IMPORT,
    TransactionSource.RECURRING,
  ]),
  raw_input: z.string().optional(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export const CreateTransactionSchema = z.object({
  account_id: z.string().uuid(),
  category_id: z.string().uuid().nullable().optional(),
  type: z.enum([TransactionType.INCOME, TransactionType.EXPENSE, TransactionType.TRANSFER]),
  amount: z.number().positive(),
  description: z.string().max(500).optional(),
  transaction_date: z.coerce.date(),
  status: z
    .enum([TransactionStatus.CONFIRMED, TransactionStatus.PENDING, TransactionStatus.CANCELLED])
    .default(TransactionStatus.CONFIRMED),
  source: z
    .enum([
      TransactionSource.MANUAL,
      TransactionSource.WHATSAPP,
      TransactionSource.AI,
      TransactionSource.IMPORT,
      TransactionSource.RECURRING,
    ])
    .default(TransactionSource.MANUAL),
  raw_input: z.string().optional(),
});

export const UpdateTransactionSchema = CreateTransactionSchema.partial();

export const TransactionFiltersSchema = z.object({
  period_start: z.coerce.date().optional(),
  period_end: z.coerce.date().optional(),
  type: z
    .enum([TransactionType.INCOME, TransactionType.EXPENSE, TransactionType.TRANSFER])
    .optional(),
  category_id: z.string().uuid().optional(),
  account_id: z.string().uuid().optional(),
  status: z
    .enum([TransactionStatus.CONFIRMED, TransactionStatus.PENDING, TransactionStatus.CANCELLED])
    .optional(),
  source: z
    .enum([
      TransactionSource.MANUAL,
      TransactionSource.WHATSAPP,
      TransactionSource.AI,
      TransactionSource.IMPORT,
      TransactionSource.RECURRING,
    ])
    .optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  sort_by: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type Transaction = z.infer<typeof TransactionSchema>;
export type CreateTransactionDto = z.infer<typeof CreateTransactionSchema>;
export type UpdateTransactionDto = z.infer<typeof UpdateTransactionSchema>;
export type TransactionFilters = z.infer<typeof TransactionFiltersSchema>;

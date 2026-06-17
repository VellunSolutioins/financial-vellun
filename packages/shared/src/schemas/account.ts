import { z } from 'zod';

import { AccountType } from '../enums';

export const AccountSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  name: z.string().min(1).max(100),
  type: z.enum([
    AccountType.CHECKING,
    AccountType.SAVINGS,
    AccountType.CASH,
    AccountType.CREDIT_CARD,
    AccountType.DIGITAL_WALLET,
    AccountType.INVESTMENT,
    AccountType.OTHER,
  ]),
  initial_balance: z.number(),
  current_balance: z.number(),
  currency: z.string().length(3).default('BRL'),
  is_active: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export const CreateAccountSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum([
    AccountType.CHECKING,
    AccountType.SAVINGS,
    AccountType.CASH,
    AccountType.CREDIT_CARD,
    AccountType.DIGITAL_WALLET,
    AccountType.INVESTMENT,
    AccountType.OTHER,
  ]),
  initial_balance: z.number().default(0),
  currency: z.string().length(3).default('BRL'),
});

export const UpdateAccountSchema = CreateAccountSchema.partial();

export type Account = z.infer<typeof AccountSchema>;
export type CreateAccountDto = z.infer<typeof CreateAccountSchema>;
export type UpdateAccountDto = z.infer<typeof UpdateAccountSchema>;

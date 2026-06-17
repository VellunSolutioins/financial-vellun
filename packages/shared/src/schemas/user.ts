import { z } from 'zod';

import { ProfileType } from '../enums';

export const CreateUserSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().min(8),
  profile_type: z.enum([ProfileType.INDIVIDUAL, ProfileType.BUSINESS]),
});

export const UpdateUserSchema = z.object({
  name: z.string().min(2).max(100).optional(),
});

export const CreateIndividualProfileSchema = z.object({
  cpf: z
    .string()
    .regex(/^\d{3}\.\d{3}\.\d{3}-\d{2}$|^\d{11}$/, 'CPF inválido')
    .optional(),
  birth_date: z.coerce.date().optional(),
});

export const CreateBusinessProfileSchema = z.object({
  company_name: z.string().min(2).max(200),
  trade_name: z.string().max(200).optional(),
  cnpj: z
    .string()
    .regex(/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$|^\d{14}$/, 'CNPJ inválido')
    .optional(),
});

export type CreateUserDto = z.infer<typeof CreateUserSchema>;
export type UpdateUserDto = z.infer<typeof UpdateUserSchema>;
export type CreateIndividualProfileDto = z.infer<typeof CreateIndividualProfileSchema>;
export type CreateBusinessProfileDto = z.infer<typeof CreateBusinessProfileSchema>;

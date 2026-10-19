import type { UseFormReturn } from 'react-hook-form';
import { z } from 'zod';
import type { register as registerUser } from '@/lib/auth';
import { PHONE_REGEX } from '@/lib/masks';

/**
 * Schema do cadastro: só os dados pessoais. CPF e endereço são exigidos ao
 * assinar, pelo provedor de pagamentos, e preenchidos em "Minha Conta".
 *
 * Todo campo é texto e nasce como `''` (`SIGNUP_DEFAULTS`). Um valor de outro
 * tipo (`undefined`, por exemplo) faria o Zod abortar o objeto e pular o
 * `superRefine`, e "Senhas não coincidem" só apareceria depois de os outros
 * campos estarem válidos.
 */
export const signupSchema = z
  .object({
    name: z.string().min(2, 'Nome deve ter ao menos 2 caracteres'),
    email: z.string().email('Email inválido'),
    phone: z.string().regex(PHONE_REGEX, 'Celular inválido ((00) 00000-0000)'),
    password: z.string().min(8, 'Senha deve ter ao menos 8 caracteres'),
    confirmPassword: z.string(),
  })
  .superRefine((d, ctx) => {
    if (d.password !== d.confirmPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Senhas não coincidem',
        path: ['confirmPassword'],
      });
    }
  });

export type SignupFormValues = z.infer<typeof signupSchema>;
export type SignupField = keyof SignupFormValues;
export type SignupFormApi = UseFormReturn<SignupFormValues>;

export const SIGNUP_DEFAULTS: SignupFormValues = {
  name: '',
  email: '',
  phone: '',
  password: '',
  confirmPassword: '',
};

/** Campos na ordem em que aparecem (define o primeiro erro a focar). */
export const FIELD_ORDER: readonly SignupField[] = [
  'name',
  'email',
  'phone',
  'password',
  'confirmPassword',
];

/**
 * Monta o corpo de `POST /auth/register` no formato que a API espera.
 *
 * O cadastro público cria só conta de pessoa física: a escolha de tipo de conta
 * (e os campos de razão social e CNPJ) volta ao formulário quando a pessoa
 * jurídica for lançada. A API continua aceitando os dois tipos.
 */
export function toRegisterPayload(data: SignupFormValues): Parameters<typeof registerUser>[0] {
  return {
    name: data.name,
    email: data.email,
    phone: data.phone,
    password: data.password,
    profileType: 'individual',
  };
}

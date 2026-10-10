import type { UseFormReturn } from 'react-hook-form';
import { z } from 'zod';
import type { register as registerUser } from '@/lib/auth';
import { CEP_REGEX, CPF_REGEX, PHONE_REGEX, isValidCpf } from '@/lib/masks';

const optionalText = z.string().optional().or(z.literal(''));

/**
 * Schema único das duas etapas do cadastro.
 *
 * Todo campo é texto e nasce como `''` (`SIGNUP_DEFAULTS`). Um valor de outro
 * tipo (`undefined`, por exemplo) faria o Zod abortar o objeto e pular o
 * `superRefine`, e "Senhas não coincidem" só apareceria depois de a outra etapa
 * estar válida.
 */
export const signupSchema = z
  .object({
    name: z.string().min(2, 'Nome deve ter ao menos 2 caracteres'),
    email: z.string().email('Email inválido'),
    phone: z.string().regex(PHONE_REGEX, 'Celular inválido ((00) 00000-0000)'),
    password: z.string().min(8, 'Senha deve ter ao menos 8 caracteres'),
    confirmPassword: z.string(),
    cpf: z
      .string()
      .regex(CPF_REGEX, 'CPF inválido (000.000.000-00)')
      .refine(isValidCpf, 'CPF inválido (dígito verificador)'),
    birthDate: optionalText,
    postalCode: z.string().regex(CEP_REGEX, 'CEP inválido (00000-000)'),
    street: z.string().min(2, 'Logradouro obrigatório'),
    addressNumber: z.string().min(1, 'Número obrigatório'),
    complement: optionalText,
    neighborhood: z.string().min(2, 'Bairro obrigatório'),
    city: z.string().min(2, 'Cidade obrigatória'),
    state: z.string().regex(/^[A-Za-z]{2}$/, 'UF (2 letras)'),
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
export type SignupStep = 0 | 1;

export const SIGNUP_STEPS = ['Seus dados', 'Documento e endereço'] as const;

export const SIGNUP_DEFAULTS: SignupFormValues = {
  name: '',
  email: '',
  phone: '',
  password: '',
  confirmPassword: '',
  cpf: '',
  birthDate: '',
  postalCode: '',
  street: '',
  addressNumber: '',
  complement: '',
  neighborhood: '',
  city: '',
  state: '',
};

/** Campos de cada etapa, na ordem em que aparecem (define o primeiro erro a focar). */
export const STEP_FIELDS: readonly [readonly SignupField[], readonly SignupField[]] = [
  ['name', 'email', 'phone', 'password', 'confirmPassword'],
  [
    'cpf',
    'birthDate',
    'postalCode',
    'street',
    'addressNumber',
    'complement',
    'neighborhood',
    'city',
    'state',
  ],
];

export const FIELD_ORDER: readonly SignupField[] = [...STEP_FIELDS[0], ...STEP_FIELDS[1]];

export function stepOf(field: SignupField): SignupStep {
  return STEP_FIELDS[0].includes(field) ? 0 : 1;
}

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
    postalCode: data.postalCode,
    street: data.street,
    addressNumber: data.addressNumber,
    complement: data.complement?.trim() ? data.complement : undefined,
    neighborhood: data.neighborhood,
    city: data.city,
    state: data.state.toUpperCase(),
    profileType: 'individual',
    cpf: data.cpf,
    birthDate: data.birthDate?.trim() ? data.birthDate : undefined,
  };
}

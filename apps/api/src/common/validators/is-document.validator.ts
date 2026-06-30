import { registerDecorator, ValidationOptions } from 'class-validator';

import { isValidCnpj, isValidCpf } from '../document.util';

/** Valida o dígito verificador do CPF (além do formato garantido por `@Matches`). */
export function IsCpf(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isCpf',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate: (value: unknown) => typeof value === 'string' && isValidCpf(value),
        defaultMessage: () => 'CPF inválido',
      },
    });
  };
}

/** Valida o dígito verificador do CNPJ (além do formato garantido por `@Matches`). */
export function IsCnpj(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isCnpj',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate: (value: unknown) => typeof value === 'string' && isValidCnpj(value),
        defaultMessage: () => 'CNPJ inválido',
      },
    });
  };
}

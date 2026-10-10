import { BadRequestException, HttpStatus, ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

import { RegisterDto } from '../auth/dto/register.dto';
import { fieldConflict, validationExceptionFactory } from './field-errors';

function validationError(
  property: string,
  constraints?: Record<string, string>,
  children: ValidationError[] = [],
): ValidationError {
  return { property, constraints, children };
}

describe('validationExceptionFactory', () => {
  it('mantém `message` como lista de textos e acrescenta o campo de cada um', () => {
    const exception = validationExceptionFactory([
      validationError('postalCode', { matches: 'CEP inválido (formato: 00000-000)' }),
      validationError('state', { matches: 'UF inválida (2 letras, ex.: PR)' }),
    ]);

    expect(exception.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(exception.getResponse()).toEqual({
      statusCode: 400,
      message: ['CEP inválido (formato: 00000-000)', 'UF inválida (2 letras, ex.: PR)'],
      error: 'Bad Request',
      errors: [
        { field: 'postalCode', message: 'CEP inválido (formato: 00000-000)' },
        { field: 'state', message: 'UF inválida (2 letras, ex.: PR)' },
      ],
    });
  });

  it('devolve uma entrada por regra violada no mesmo campo', () => {
    const exception = validationExceptionFactory([
      validationError('name', { isString: 'name must be a string', minLength: 'curto demais' }),
    ]);

    expect(exception.getResponse()).toMatchObject({
      errors: [
        { field: 'name', message: 'name must be a string' },
        { field: 'name', message: 'curto demais' },
      ],
    });
  });

  it('usa o caminho com ponto em campo aninhado, como o Nest faz na mensagem', () => {
    const exception = validationExceptionFactory([
      validationError('items', undefined, [
        validationError('0', undefined, [
          validationError('amount', { isPositive: 'amount must be a positive number' }),
        ]),
      ]),
    ]);

    expect(exception.getResponse()).toMatchObject({
      message: ['items.0.amount must be a positive number'],
      errors: [{ field: 'items.0.amount', message: 'items.0.amount must be a positive number' }],
    });
  });
});

describe('ValidationPipe com a fábrica (configuração do main.ts)', () => {
  it('aponta o campo de cada erro de um corpo real do cadastro', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      exceptionFactory: validationExceptionFactory,
    });

    const error = await pipe
      .transform(
        { name: 'Ana', email: 'nao-e-email', sobrando: 1 },
        { type: 'body', metatype: RegisterDto },
      )
      .catch((e: BadRequestException) => e);

    const body = (error as BadRequestException).getResponse() as {
      message: string[];
      errors: { field: string; message: string }[];
    };
    expect(body.errors).toEqual(
      expect.arrayContaining([
        { field: 'email', message: 'email must be an email' },
        { field: 'postalCode', message: 'CEP inválido (formato: 00000-000)' },
        { field: 'sobrando', message: 'property sobrando should not exist' },
      ]),
    );
    expect(body.message).toEqual(body.errors.map((item) => item.message));
  });
});

describe('fieldConflict', () => {
  it('preserva o texto como mensagem da exceção e aponta o campo', () => {
    const exception = fieldConflict('email', 'Email já cadastrado');

    expect(exception.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(exception.message).toBe('Email já cadastrado');
    expect(exception.getResponse()).toEqual({
      statusCode: 409,
      message: 'Email já cadastrado',
      error: 'Conflict',
      errors: [{ field: 'email', message: 'Email já cadastrado' }],
    });
  });
});

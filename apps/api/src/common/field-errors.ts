import { BadRequestException, ConflictException, HttpStatus } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

/**
 * Erro ligado a um campo do corpo da requisição.
 *
 * Vai como lista de `{ field, message }`, e não como objeto indexado pelo nome
 * do campo: o filtro de exceções passa o corpo por `sanitizeForLog`, que redige
 * o valor de chaves como `email`, `cpf` e `password` — a mensagem sairia
 * mascarada.
 */
export interface FieldError {
  field: string;
  message: string;
}

function collect(error: ValidationError, parentPath?: string): FieldError[] {
  const path = parentPath ? `${parentPath}.${error.property}` : error.property;
  if (error.children?.length) {
    return error.children.flatMap((child) => collect(child, path));
  }
  // Mesmo texto do Nest: em campo aninhado, a mensagem leva o caminho do pai.
  return Object.values(error.constraints ?? {}).map((message) => ({
    field: path,
    message: parentPath ? `${parentPath}.${message}` : message,
  }));
}

/**
 * `exceptionFactory` do `ValidationPipe`. O corpo mantém `message` como a lista
 * de textos que o Nest já devolvia e acrescenta `errors`, com o campo de cada um.
 */
export function validationExceptionFactory(errors: ValidationError[]): BadRequestException {
  const fieldErrors = errors.flatMap((error) => collect(error));
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    message: fieldErrors.map((item) => item.message),
    error: 'Bad Request',
    errors: fieldErrors,
  });
}

/** Conflito de valor único (e-mail, CPF, CNPJ) apontando o campo responsável. */
export function fieldConflict(field: string, message: string): ConflictException {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    message,
    error: 'Conflict',
    errors: [{ field, message }],
  });
}

import { HttpStatus, Logger } from '@nestjs/common';
import { lastValueFrom, throwError } from 'rxjs';

import {
  PaymentProviderErrorInterceptor,
  toHttpException,
} from './payment-provider-error.interceptor';
import { PaymentProviderError } from './providers/payment-provider.errors';

describe('falha do PSP para HTTP', () => {
  it.each([
    ['validation', HttpStatus.BAD_REQUEST],
    ['unauthorized', HttpStatus.UNAUTHORIZED],
    ['not_found', HttpStatus.BAD_GATEWAY],
    ['unavailable', HttpStatus.SERVICE_UNAVAILABLE],
    ['not_supported', HttpStatus.NOT_IMPLEMENTED],
  ] as const)('%s vira %s', (kind, status) => {
    expect(toHttpException(new PaymentProviderError(kind, 'x')).getStatus()).toBe(status);
  });

  it('recusa de dados leva a mensagem do PSP ao usuário; as demais, não', () => {
    const validation = toHttpException(
      new PaymentProviderError('validation', 'O CPF/CNPJ informado é inválido.', {
        userFacing: true,
      }),
    );
    expect(validation.message).toBe('O CPF/CNPJ informado é inválido.');

    // Recusa sem mensagem para o usuário (ex.: 400 numa consulta) não vaza a técnica.
    const technical = toHttpException(
      new PaymentProviderError('validation', 'Asaas GET /payments/pay_1 falhou (HTTP 400)'),
    );
    expect(technical.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(technical.message).not.toContain('Asaas');

    // A mensagem interna (URL, status do PSP) fica no log, não na resposta.
    const unavailable = toHttpException(
      new PaymentProviderError('unavailable', 'Asaas GET /payments/x não respondeu'),
    );
    expect(unavailable.message).not.toContain('Asaas');
  });

  it('o interceptor traduz o erro do PSP e deixa os demais passarem como vieram', async () => {
    const interceptor = new PaymentProviderErrorInterceptor();
    const run = (error: unknown) =>
      lastValueFrom(interceptor.intercept({} as any, { handle: () => throwError(() => error) }));

    await expect(run(new PaymentProviderError('validation', 'dado ruim'))).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
    const other = new Error('outro');
    await expect(run(other)).rejects.toBe(other);
  });

  it('o motivo real fica no log, já que a resposta leva uma mensagem genérica', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const interceptor = new PaymentProviderErrorInterceptor();

    await lastValueFrom(
      interceptor.intercept({} as any, {
        handle: () =>
          throwError(
            () => new PaymentProviderError('unavailable', 'Credenciais do Asaas não configuradas'),
          ),
      }),
    ).catch(() => undefined);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Credenciais do Asaas'));
    warn.mockRestore();
  });
});

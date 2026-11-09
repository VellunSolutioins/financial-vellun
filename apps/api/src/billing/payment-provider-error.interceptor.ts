import {
  BadGatewayException,
  BadRequestException,
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
  NotImplementedException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';

import { PaymentProviderError } from './providers/payment-provider.errors';

/** Resposta HTTP de cada tipo de falha do PSP. */
export function toHttpException(error: PaymentProviderError): HttpException {
  switch (error.kind) {
    case 'validation':
      // Só a mensagem escrita para o usuário (a do PSP sobre os dados dele)
      // sai na resposta; a técnica nomearia o PSP, a rota e ids internos.
      return new BadRequestException(
        error.userFacing ? error.message : 'O provedor de pagamentos recusou a operação.',
      );
    case 'unauthorized':
      return new UnauthorizedException(error.message);
    case 'not_supported':
      return new NotImplementedException(error.message);
    case 'not_found':
      // O PSP não achou algo que este sistema criou: falha nossa ou dele.
      return new BadGatewayException('O provedor de pagamentos não reconheceu a operação.');
    case 'unavailable':
    default:
      return new ServiceUnavailableException(
        'O provedor de pagamentos está indisponível. Tente novamente em instantes.',
      );
  }
}

/**
 * Traduz {@link PaymentProviderError} para HTTP nas rotas de billing.
 *
 * Interceptor, e não filtro de exceção: o erro traduzido segue para o filtro
 * global, que é quem loga, sanitiza e conta a resposta. Um filtro próprio aqui
 * responderia por fora dele.
 *
 * O filtro só vê a exceção traduzida, de mensagem genérica; o motivo real
 * ("credenciais não configuradas", "HTTP 500") fica no log daqui.
 */
@Injectable()
export class PaymentProviderErrorInterceptor implements NestInterceptor {
  private readonly logger = new Logger(PaymentProviderErrorInterceptor.name);

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (!(error instanceof PaymentProviderError)) return throwError(() => error);
        this.logger.warn(`Falha no PSP (${error.kind}): ${error.message}`);
        return throwError(() => toHttpException(error));
      }),
    );
  }
}

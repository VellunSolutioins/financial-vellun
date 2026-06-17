import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers['x-internal-api-key'];
    const expected = this.configService.getOrThrow<string>('INTERNAL_API_KEY');

    if (!provided || provided !== expected) {
      throw new UnauthorizedException('Chave de API interna inválida');
    }

    return true;
  }
}

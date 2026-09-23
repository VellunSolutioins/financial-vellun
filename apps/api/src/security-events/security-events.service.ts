import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/** Eventos registrados na trilha da conta. */
export type SecurityEventType =
  | 'password_changed'
  | 'email_changed'
  | 'phone_verified'
  | 'sessions_revoked';

/** Origem da requisição que provocou a mudança. */
export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

export interface SecurityEventContext extends RequestContext {
  metadata?: Prisma.InputJsonValue;
}

const USER_AGENT_MAX = 255;

/**
 * Trilha append-only das mudanças de identidade da conta (plano de segurança, S4).
 *
 * Serve para o usuário e o suporte reconstruírem o que aconteceu — trocaram a
 * senha? o e-mail? de onde? — e é gravada mesmo quando a ação partiu de uma
 * sessão legítima, porque é justamente a sessão roubada que parece legítima.
 *
 * **Best-effort**: falhar em registrar não pode desfazer a troca de senha que o
 * usuário acabou de pedir. A falha vai para o log da aplicação.
 */
@Injectable()
export class SecurityEventsService {
  private readonly logger = new Logger(SecurityEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(
    userId: string,
    type: SecurityEventType,
    context: SecurityEventContext = {},
  ): Promise<void> {
    try {
      await this.prisma.userSecurityEvent.create({
        data: {
          userId,
          type,
          ip: context.ip,
          userAgent: context.userAgent?.slice(0, USER_AGENT_MAX),
          metadata: context.metadata,
        },
      });
    } catch (error) {
      this.logger.error(
        `Falha ao registrar evento de segurança (${type}) do usuário ${userId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}

/** `joao.silva@example.com` → `j***@example.com`. A trilha não guarda o e-mail inteiro. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

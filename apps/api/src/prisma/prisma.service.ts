import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Cliente Prisma com ciclo de vida amarrado ao do Nest.
 *
 * O `$disconnect` no shutdown não é higiene: sem ele, cada deploy deixava as
 * conexões da instância antiga abertas até o Postgres expirá-las por conta
 * própria. Com `overlapSeconds` (a instância nova sobe antes de a antiga
 * morrer), as duas somam conexões ao mesmo tempo — e é justamente durante o
 * deploy que o `max_connections` estoura, no pior momento possível para
 * diagnosticar.
 *
 * Só funciona com `app.enableShutdownHooks()` no `main.ts`: sem ele o Nest não
 * escuta SIGTERM e `onModuleDestroy` nunca roda.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.$disconnect();
    } catch (error) {
      // Encerrando: falhar aqui não pode impedir o processo de sair.
      this.logger.warn(`Falha ao desconectar do Postgres: ${(error as Error).name}`);
    }
  }
}

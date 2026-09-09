import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { OpsAuditService } from './audit/ops-audit.service';
import { GithubOAuthClient } from './auth/github-oauth.client';
import { OpsAuthController } from './auth/ops-auth.controller';
import { OpsAuthService } from './auth/ops-auth.service';
import { OpsSessionService } from './auth/ops-session.service';
import { OpsAuthGuard } from './auth/guards/ops-auth.guard';
import { OpsRolesGuard } from './auth/guards/ops-roles.guard';
import { OpsOperatorsController } from './operators/ops-operators.controller';
import { OpsOperatorsService } from './operators/ops-operators.service';

/**
 * Área de operações: identidade própria (GitHub OAuth + organização), papéis e
 * trilha de auditoria.
 *
 * O módulo **não** importa `AuthModule`. Isso é intencional e estrutural: não
 * existe caminho de código entre a identidade do cliente (`users`) e a do
 * operador (`ops_operators`), então nenhum usuário do produto vira operador por
 * um bug de autorização.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [OpsAuthController, OpsOperatorsController],
  providers: [
    OpsAuthService,
    OpsSessionService,
    GithubOAuthClient,
    OpsAuditService,
    OpsAuthGuard,
    OpsRolesGuard,
    OpsOperatorsService,
  ],
  exports: [OpsAuditService, OpsAuthGuard, OpsRolesGuard, OpsSessionService],
})
export class OpsModule {}

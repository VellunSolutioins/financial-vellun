import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { OpsAuditController } from './audit/ops-audit.controller';
import { OpsAuditQueryService } from './audit/ops-audit-query.service';
import { OpsAuditService } from './audit/ops-audit.service';
import { GithubOAuthClient } from './auth/github-oauth.client';
import { OpsAuthController } from './auth/ops-auth.controller';
import { OpsAuthService } from './auth/ops-auth.service';
import { OpsSessionService } from './auth/ops-session.service';
import { OpsAuthGuard } from './auth/guards/ops-auth.guard';
import { OpsRolesGuard } from './auth/guards/ops-roles.guard';
import { FailureRetentionService } from './failures/failure-retention.service';
import { OpsFailuresController } from './failures/ops-failures.controller';
import { OpsFailuresInternalController } from './failures/ops-failures-internal.controller';
import { OpsFailedMessagesService } from './failures/ops-failed-messages.service';
import { OpsFailuresQueryService } from './failures/ops-failures-query.service';
import { OpsGrafanaService } from './grafana/ops-grafana.service';
import { OpsOperatorsController } from './operators/ops-operators.controller';
import { OpsOperatorsService } from './operators/ops-operators.service';
import { OpsOverviewController } from './overview/ops-overview.controller';
import { OpsOverviewService } from './overview/ops-overview.service';
import { OpsPaymentsController } from './payments/ops-payments.controller';
import { OpsPaymentsQueryService } from './payments/ops-payments-query.service';

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
  controllers: [
    OpsAuthController,
    OpsOperatorsController,
    OpsFailuresController,
    OpsFailuresInternalController,
    OpsOverviewController,
    OpsPaymentsController,
    OpsAuditController,
  ],
  providers: [
    OpsAuthService,
    OpsSessionService,
    GithubOAuthClient,
    OpsAuditService,
    OpsAuthGuard,
    OpsRolesGuard,
    OpsOperatorsService,
    OpsFailedMessagesService,
    OpsFailuresQueryService,
    FailureRetentionService,
    OpsOverviewService,
    OpsGrafanaService,
    OpsPaymentsQueryService,
    OpsAuditQueryService,
  ],
  exports: [
    OpsAuditService,
    OpsAuthGuard,
    OpsRolesGuard,
    OpsSessionService,
    OpsFailedMessagesService,
    OpsFailuresQueryService,
  ],
})
export class OpsModule {}

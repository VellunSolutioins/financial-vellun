import { randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpsAuditResult, OpsOperator, OpsRole, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { OpsAuditService } from '../audit/ops-audit.service';
import { OPS_AUDIT_ACTIONS, OPS_AUDIT_TARGETS } from '../ops.constants';
import { GithubIdentity, GithubOAuthClient } from './github-oauth.client';

/** Por que um login não resultou em sessão. */
export type OpsLoginRejection = 'not_org_member' | 'inactive';

export type OpsLoginOutcome =
  | { status: 'authorized'; operator: OpsOperator }
  | { status: 'rejected'; reason: OpsLoginRejection; operator: OpsOperator | null };

@Injectable()
export class OpsAuthService {
  private readonly logger = new Logger(OpsAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubOAuthClient,
    private readonly audit: OpsAuditService,
    private readonly config: ConfigService,
  ) {}

  newOauthState(): string {
    return randomBytes(32).toString('hex');
  }

  /** Compara o `state` da querystring com o do cookie, sem vazar tempo. */
  stateMatches(fromQuery: string | undefined, fromCookie: string | undefined): boolean {
    if (!fromQuery || !fromCookie) return false;

    const a = Buffer.from(fromQuery);
    const b = Buffer.from(fromCookie);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Resolve o login: troca o `code`, verifica pertencimento à organização e
   * decide se há sessão.
   *
   * A ordem importa. Quem não pertence à organização **não é registrado** em
   * `ops_operators` — a tabela é a lista de operadores conhecidos, não um log de
   * tentativas; para isso existe `ops_audit_log`. Quem pertence é registrado, mas
   * o primeiro login entra como `viewer` inativo: pertencer é condição
   * necessária, não suficiente.
   */
  async completeLogin(code: string): Promise<OpsLoginOutcome> {
    const token = await this.github.exchangeCode(code);
    const identity = await this.github.fetchIdentity(token);

    if (!(await this.github.isActiveOrgMember(token))) {
      await this.recordDeniedLogin(identity, 'not_org_member');
      return { status: 'rejected', reason: 'not_org_member', operator: null };
    }

    const operator = await this.upsertOperator(identity);

    if (!operator.active) {
      await this.audit.recordBestEffort({
        operatorId: operator.id,
        action: OPS_AUDIT_ACTIONS.loginDenied,
        targetType: OPS_AUDIT_TARGETS.operator,
        targetId: operator.id,
        reason: 'operador inativo — precisa de ativação por um ops_admin',
        result: OpsAuditResult.denied,
      });
      return { status: 'rejected', reason: 'inactive', operator };
    }

    const active = await this.prisma.opsOperator.update({
      where: { id: operator.id },
      data: { lastLoginAt: new Date() },
    });

    await this.audit.recordBestEffort({
      operatorId: active.id,
      action: OPS_AUDIT_ACTIONS.loginSucceeded,
      targetType: OPS_AUDIT_TARGETS.operator,
      targetId: active.id,
      result: OpsAuditResult.success,
    });

    return { status: 'authorized', operator: active };
  }

  /**
   * Cria ou atualiza o operador a partir da identidade do GitHub.
   *
   * A chave é o `githubUserId`, não o `githubLogin`: um login pode ser trocado
   * pelo dono (e o antigo, reivindicado por outra pessoa), enquanto o id é
   * imutável. `role`, `active` e `canViewSensitive` **nunca** são tocados aqui —
   * quem concede permissão é um `ops_admin`, não o ato de fazer login.
   *
   * `githubLogin` também é único, e é aí que a troca de login morde: se o dono
   * antigo renomeou a conta e ainda não voltou a entrar, a linha dele segue com o
   * login que agora é de outra pessoa, e o upsert dela falhava com P2002 — um
   * login legítimo recusado sem explicação. A linha antiga tem o login liberado
   * antes, na mesma transação.
   */
  private async upsertOperator(identity: GithubIdentity): Promise<OpsOperator> {
    const bootstrap = await this.bootstrapGrant(identity);

    return this.prisma.$transaction(async (tx) => {
      await this.releaseStaleLogin(tx, identity);

      return tx.opsOperator.upsert({
        where: { githubUserId: identity.githubUserId },
        create: {
          githubUserId: identity.githubUserId,
          githubLogin: identity.login,
          name: identity.name,
          email: identity.email,
          ...bootstrap,
        },
        update: {
          githubLogin: identity.login,
          name: identity.name,
          email: identity.email,
        },
      });
    });
  }

  /**
   * Tira o login de uma linha que não pertence mais a ele.
   *
   * Só o `githubLogin` muda: papel, ativação e permissões seguem presos ao
   * `githubUserId` da linha antiga, que é quem de fato os recebeu — e que volta a
   * ter o login atualizado no próximo login dele. O valor usa `~`, que o GitHub
   * não aceita em login, e o id da linha, que é único: não colide com nenhum
   * login real nem com outra linha liberada.
   */
  private async releaseStaleLogin(
    tx: Prisma.TransactionClient,
    identity: GithubIdentity,
  ): Promise<void> {
    const stale = await tx.opsOperator.findUnique({ where: { githubLogin: identity.login } });
    if (!stale || stale.githubUserId === identity.githubUserId) return;

    await tx.opsOperator.update({
      where: { id: stale.id },
      data: { githubLogin: `${identity.login}~liberado-${stale.githubUserId}` },
    });
    this.logger.warn(
      `Login GitHub "${identity.login}" passou do usuário ${stale.githubUserId} para ` +
        `${identity.githubUserId}; linha antiga ficou com o login liberado`,
    );
  }

  /**
   * Resolve o ovo-e-galinha do primeiro operador.
   *
   * Sem isso ninguém entra: todo primeiro login nasce `viewer` inativo, e ativar
   * exige um `ops_admin` que não existe. A saída é um único operador semeado, e
   * as três condições são cumulativas de propósito:
   *
   * - `OPS_BOOTSTRAP_ADMIN_GITHUB_LOGIN` precisa estar configurado (nomeando
   *   **quem**, para que não seja "o primeiro que chegar" — numa organização com
   *   vários membros isso seria uma corrida por privilégio);
   * - o login precisa ser exatamente aquele;
   * - a tabela precisa estar **vazia**, então a variável deixa de ter efeito no
   *   instante em que existe um operador. Esquecê-la no ambiente não reabre nada.
   */
  private async bootstrapGrant(
    identity: GithubIdentity,
  ): Promise<{ role: OpsRole; active: boolean } | Record<string, never>> {
    const expected = this.config.get<string>('OPS_BOOTSTRAP_ADMIN_GITHUB_LOGIN')?.trim();
    if (!expected || expected.toLowerCase() !== identity.login.toLowerCase()) return {};

    if ((await this.prisma.opsOperator.count()) > 0) return {};

    this.logger.warn(
      `Semeando o primeiro operador como ops_admin ativo: "${identity.login}". ` +
        'A variável OPS_BOOTSTRAP_ADMIN_GITHUB_LOGIN não tem mais efeito e pode ser removida.',
    );
    return { role: OpsRole.ops_admin, active: true };
  }

  /**
   * Registra a tentativa de quem não pertence à organização.
   *
   * `ops_audit_log.operatorId` é obrigatório e referencia `ops_operators`, então
   * não há como apontar para um desconhecido. Fica no log da aplicação — que vai
   * para o Loki e é onde essa tentativa precisa ser vista.
   */
  private async recordDeniedLogin(
    identity: GithubIdentity,
    reason: OpsLoginRejection,
  ): Promise<void> {
    this.logger.warn(
      `Login de operações recusado (${reason}): github login "${identity.login}" (id ${identity.githubUserId}) não pertence à organização ${this.github.organization}`,
    );
  }

  async findById(id: string): Promise<OpsOperator | null> {
    return this.prisma.opsOperator.findUnique({ where: { id } });
  }
}

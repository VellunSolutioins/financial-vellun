import { SetMetadata } from '@nestjs/common';
import { OpsRole } from '@prisma/client';

export const OPS_ROLES = 'ops:roles';

/**
 * Papéis autorizados na rota. Sem o decorator, o {@link OpsRolesGuard} exige
 * apenas sessão válida — o que basta para leitura, já que todo operador ativo é
 * no mínimo `viewer`.
 *
 * Os papéis **não** são hierárquicos por si: `@OpsRoles('operator')` não inclui
 * `ops_admin`. Liste explicitamente quem pode, para que ler o decorator baste
 * para saber a resposta.
 */
export const OpsRoles = (...roles: OpsRole[]) => SetMetadata(OPS_ROLES, roles);

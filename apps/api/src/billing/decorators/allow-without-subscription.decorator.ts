import { SetMetadata } from '@nestjs/common';

export const ALLOW_WITHOUT_SUBSCRIPTION = 'allowWithoutSubscription';

/**
 * Libera uma rota do {@link ActiveSubscriptionGuard}, permitindo acesso sem
 * assinatura ativa (ex.: exportação/exclusão de dados dentro de um controller
 * já protegido). Login/cadastro/billing já ficam fora do guard por não o aplicarem.
 */
export const AllowWithoutSubscription = () => SetMetadata(ALLOW_WITHOUT_SUBSCRIPTION, true);

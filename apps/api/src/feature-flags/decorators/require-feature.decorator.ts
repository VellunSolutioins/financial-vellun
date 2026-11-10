import type { FeatureKey } from '@financial-vellun/shared';
import { SetMetadata } from '@nestjs/common';

export const REQUIRED_FEATURE = 'requiredFeature';

/**
 * Marca a rota (ou o controller inteiro) como parte de uma funcionalidade com
 * feature flag. Só tem efeito junto do {@link FeatureEnabledGuard}.
 */
export const RequireFeature = (key: FeatureKey) => SetMetadata(REQUIRED_FEATURE, key);

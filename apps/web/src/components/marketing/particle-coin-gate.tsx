'use client';
import { ParticleCoin } from './particle-coin';
import { useCoinEnabled } from './use-coin-enabled';

/** Monta o canvas de partículas (que cobre o hero inteiro) só a partir do tablet. */
export function ParticleCoinGate() {
  return useCoinEnabled() ? <ParticleCoin /> : null;
}

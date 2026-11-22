import { type FeatureFlags, allFeaturesOff } from './features';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** Quanto tempo (s) a home reaproveita o estado das flags antes de consultar de novo. */
const REVALIDATE_SECONDS = 300;

/**
 * Flags para as páginas públicas, lidas no servidor e sem sessão
 * (`GET /features/public`). Se a API não responder — inclusive no build —,
 * tudo conta como desligado e a página mostra o texto conservador.
 */
export async function getPublicFeatures(): Promise<FeatureFlags> {
  try {
    const res = await fetch(`${API_URL}/features/public`, {
      next: { revalidate: REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return allFeaturesOff();
    return { ...allFeaturesOff(), ...((await res.json()) as Partial<FeatureFlags>) };
  } catch {
    return allFeaturesOff();
  }
}

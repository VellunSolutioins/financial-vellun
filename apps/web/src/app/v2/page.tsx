import { LandingV2, landingV2Metadata } from '@/components/marketing/landing-v2';

export const metadata = landingV2Metadata;

/** Landing nova com a moeda de partículas 3D. */
export default function HomePageV2() {
  return <LandingV2 coin="particulas" home="/v2" />;
}

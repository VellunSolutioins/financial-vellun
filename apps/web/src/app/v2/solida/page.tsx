import { LandingV2, landingV2Metadata } from '@/components/marketing/landing-v2';

export const metadata = landingV2Metadata;

/** Landing nova com a moeda sólida (WebGL), para comparação. */
export default function HomePageV2Solida() {
  return <LandingV2 coin="solida" home="/v2/solida" />;
}

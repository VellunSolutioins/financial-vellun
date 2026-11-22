import { LandingV2, landingV2Metadata } from '@/components/marketing/landing-v2';

export const metadata = landingV2Metadata;

/** Landing nova com a moeda em meia-tinta (pixel), para comparação. */
export default function HomePageV2Pixel() {
  return <LandingV2 coin="pixel" home="/v2/pixel" />;
}

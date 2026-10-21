import { Suspense } from 'react';
import type { Metadata } from 'next';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';

export const metadata: Metadata = {
  title: 'Criar senha nova — Financial Vellun',
  // O token vai na URL: sem Referer, ele não vaza para links e recursos externos.
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default function RedefinirSenhaPage() {
  // `useSearchParams` exige Suspense para a página não sair toda do prerender.
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}

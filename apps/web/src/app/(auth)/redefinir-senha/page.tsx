import type { Metadata } from 'next';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';

export const metadata: Metadata = {
  title: 'Criar senha nova — Financial Vellun',
  // O token vem no fragmento e sai da barra ao ser lido; sem Referer, nem o
  // endereço desta página vaza para links e recursos externos.
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default function RedefinirSenhaPage() {
  return <ResetPasswordForm />;
}

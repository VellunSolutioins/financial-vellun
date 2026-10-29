import type { Metadata } from 'next';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';

export const metadata: Metadata = {
  title: 'Esqueci minha senha — Financial Vellun',
  description: 'Receba por email um link para criar uma senha nova.',
};

export default function EsqueciSenhaPage() {
  return <ForgotPasswordForm />;
}

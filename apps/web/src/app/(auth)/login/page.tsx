import type { Metadata } from 'next';
import { LoginForm } from '@/components/auth/login-form';

export const metadata: Metadata = {
  title: 'Entrar — Financial Vellun',
  description: 'Entre para acompanhar suas finanças no Financial Vellun.',
};

export default function LoginPage() {
  return <LoginForm />;
}

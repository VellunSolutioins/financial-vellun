import type { Metadata } from 'next';
import { LoginForm } from '@/components/auth/login-form';

export const metadata: Metadata = {
  title: 'Entrar — Zeloo',
  description: 'Entre para acompanhar suas finanças no Zeloo.',
};

export default function LoginPage() {
  return <LoginForm />;
}

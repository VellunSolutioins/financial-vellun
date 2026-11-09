import type { Metadata } from 'next';
import { SignupForm } from '@/components/auth/signup-form';

export const metadata: Metadata = {
  title: 'Criar conta — Financial Vellun',
  description: 'Crie sua conta no Financial Vellun e registre seus gastos pelo WhatsApp.',
};

export default function CadastroPage() {
  return <SignupForm />;
}

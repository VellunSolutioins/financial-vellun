'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Lock, Mail } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/contexts/auth-context';
import { useToast } from '@/components/ui/toast';
import { login } from '@/lib/auth';
import { ApiClientError } from '@/lib/api-client';

const schema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(1, 'Senha obrigatória'),
});
type FormData = z.infer<typeof schema>;

export default function LoginPage() {
  const router = useRouter();
  const { setUser } = useAuth();
  const toast = useToast();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  const onSubmit = async (data: FormData) => {
    try {
      const user = await login(data);
      setUser(user);
      toast.success('Login realizado com sucesso!');
      router.push(user.profileType === 'individual' ? '/app/pessoal/dashboard' : '/app/empresa/dashboard');
    } catch (e) {
      toast.error(e instanceof ApiClientError ? e.message : 'Ocorreu um erro. Tente novamente.');
    }
  };

  return (
    <div className="flex w-full max-w-4xl overflow-hidden rounded-2xl bg-white shadow-xl">
      {/* Painel de destaque — só em telas médias+ (mobile-first: escondido no celular) */}
      <div className="relative hidden w-2/5 flex-col justify-center overflow-visible bg-gradient-to-br from-primary to-indigo-700 p-10 text-white md:flex">
        <p className="text-sm font-medium text-white/70">Financial Vellun</p>
        <h2 className="mt-3 text-3xl font-bold leading-tight">Novo por aqui?</h2>
        <p className="mt-4 text-white/85">
          Crie sua conta e organize suas finanças pessoais ou da sua empresa em um só lugar.
        </p>
        <Link href="/cadastro" className="mt-6">
          <Button
            variant="outline"
            className="border-white bg-transparent text-white hover:bg-white hover:text-primary"
          >
            Criar conta
          </Button>
        </Link>

        <svg
          className="pointer-events-none absolute right-0 top-0 h-full w-16 translate-x-1/2"
          viewBox="0 0 100 800"
          preserveAspectRatio="none"
          aria-hidden
        >
          <path d="M50,0 Q0,200 50,400 T50,800 L100,800 L100,0 Z" fill="white" />
        </svg>
      </div>

      {/* Formulário real de login */}
      <div className="w-full p-8 sm:p-10 md:w-3/5">
        <h1 className="text-2xl font-bold">Entrar</h1>
        <p className="mt-1 text-sm text-muted-foreground">Acesse sua conta Financial Vellun</p>

        <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4">
          <div className="space-y-1">
            <Label htmlFor="email">Email</Label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="email"
                type="email"
                placeholder="seu@email.com"
                className="pl-10"
                {...register('email')}
              />
            </div>
            {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="password">Senha</Label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <PasswordInput
                id="password"
                placeholder="••••••••"
                autoComplete="current-password"
                className="pl-10"
                {...register('password')}
              />
            </div>
            {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
          </div>
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Entrando...' : 'Entrar'}
          </Button>
          <p className="text-center text-sm text-muted-foreground md:hidden">
            Não tem conta?{' '}
            <Link href="/cadastro" className="text-primary underline">
              Criar conta
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}

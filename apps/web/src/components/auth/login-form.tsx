'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { useToast } from '@/components/ui/toast';
import { textLink } from '@/components/marketing/styles';
import { useAuth } from '@/contexts/auth-context';
import { login } from '@/lib/auth';
import { apiErrorMessages } from './api-errors';
import { FormAlert } from './form-alert';
import { FormField, fieldControlClass } from './form-field';

const schema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(1, 'Senha obrigatória'),
});
type FormData = z.infer<typeof schema>;

export function LoginForm() {
  const router = useRouter();
  const { setUser } = useAuth();
  const toast = useToast();
  const [formErrors, setFormErrors] = useState<string[]>([]);
  // Mantém o botão travado entre o login aceito e a troca de página.
  const [redirecting, setRedirecting] = useState(false);

  const {
    register,
    handleSubmit,
    trigger,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  const busy = isSubmitting || redirecting;

  const onSubmit = async (data: FormData) => {
    setFormErrors([]);
    try {
      const user = await login(data);
      setUser(user);
      setRedirecting(true);
      toast.success('Login realizado com sucesso!');
      router.push(
        user.profileType === 'individual' ? '/app/pessoal/dashboard' : '/app/empresa/dashboard',
      );
    } catch (e) {
      setFormErrors(apiErrorMessages(e));
    }
  };

  return (
    <div className="mx-auto w-full max-w-[420px]">
      <h1 className="text-3xl font-bold tracking-tight text-ink">Bem-vindo de volta</h1>
      <p className="mt-2 text-base text-ink-muted">Entre para acompanhar suas finanças.</p>

      <form noValidate onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-5">
        <FormField id="login-email" label="Email" error={errors.email?.message}>
          {(control) => (
            <Input
              {...control}
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              className={fieldControlClass}
              {...register('email', { onBlur: () => void trigger('email') })}
            />
          )}
        </FormField>
        <FormField id="login-password" label="Senha" error={errors.password?.message}>
          {(control) => (
            <PasswordInput
              {...control}
              autoComplete="current-password"
              className={fieldControlClass}
              {...register('password')}
            />
          )}
        </FormField>

        <FormAlert messages={formErrors} />

        <Button type="submit" size="xl" disabled={busy} className="w-full hover:bg-primary-hover">
          {busy ? 'Entrando…' : 'Entrar'}
        </Button>
      </form>

      <p className="mt-4 text-center text-base text-ink-muted">
        Ainda não tem conta?{' '}
        <Link href="/cadastro" className={textLink}>
          Criar conta
        </Link>
      </p>
    </div>
  );
}

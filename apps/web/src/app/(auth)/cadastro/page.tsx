'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/contexts/auth-context';
import { register as registerUser, login } from '@/lib/auth';
import { ApiClientError } from '@/lib/api-client';

const schema = z
  .object({
    name: z.string().min(2, 'Nome deve ter ao menos 2 caracteres'),
    email: z.string().email('Email inválido'),
    password: z.string().min(8, 'Senha deve ter ao menos 8 caracteres'),
    confirmPassword: z.string(),
    profileType: z.enum(['individual', 'business'], { required_error: 'Selecione um tipo' }),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: 'Senhas não coincidem',
    path: ['confirmPassword'],
  });
type FormData = z.infer<typeof schema>;

export default function CadastroPage() {
  const router = useRouter();
  const { setUser } = useAuth();
  const [error, setError] = useState('');

  const {
    register,
    handleSubmit,
    trigger,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  const onSubmit = async (data: FormData) => {
    setError('');
    try {
      await registerUser({
        name: data.name,
        email: data.email,
        password: data.password,
        profileType: data.profileType,
      });
      const user = await login({ email: data.email, password: data.password });
      setUser(user);
      router.push(
        user.profileType === 'individual' ? '/app/pessoal/dashboard' : '/app/empresa/dashboard',
      );
    } catch (e) {
      if (e instanceof ApiClientError) setError(e.message);
      else setError('Ocorreu um erro. Tente novamente.');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Criar conta</CardTitle>
        <CardDescription>Crie sua conta no Financial Vellun</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1">
            <Label>Nome completo</Label>
            <Input placeholder="Seu nome" {...register('name')} />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>
          <div className="space-y-1">
            <Label>Email</Label>
            <Input
              type="email"
              placeholder="seu@email.com"
              {...register('email', { onBlur: () => void trigger('email') })}
            />
            {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
          </div>
          <div className="space-y-1">
            <Label>Senha</Label>
            <Input type="password" placeholder="Mínimo 8 caracteres" {...register('password')} />
            {errors.password && (
              <p className="text-xs text-destructive">{errors.password.message}</p>
            )}
          </div>
          <div className="space-y-1">
            <Label>Confirmar senha</Label>
            <Input type="password" placeholder="Repita a senha" {...register('confirmPassword')} />
            {errors.confirmPassword && (
              <p className="text-xs text-destructive">{errors.confirmPassword.message}</p>
            )}
          </div>
          <div className="space-y-1">
            <Label>Tipo de conta</Label>
            <Select {...register('profileType')}>
              <option value="">Selecione...</option>
              <option value="individual">Pessoa Física</option>
              <option value="business">Pessoa Jurídica</option>
            </Select>
            {errors.profileType && (
              <p className="text-xs text-destructive">{errors.profileType.message}</p>
            )}
          </div>
          {error && (
            <p className="text-sm text-destructive bg-destructive/10 rounded p-2">{error}</p>
          )}
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Criando conta...' : 'Criar conta'}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            Já tem conta?{' '}
            <Link href="/login" className="text-primary underline">
              Entrar
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

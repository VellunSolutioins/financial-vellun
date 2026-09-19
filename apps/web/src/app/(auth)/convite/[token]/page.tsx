'use client';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/contexts/auth-context';
import { useToast } from '@/components/ui/toast';
import { getInviteByToken, acceptInvite, type InviteInfo } from '@/lib/members';
import { getMe } from '@/lib/auth';
import { ApiClientError } from '@/lib/api-client';

const schema = z
  .object({
    name: z.string().min(2, 'Nome deve ter ao menos 2 caracteres'),
    password: z.string().min(6, 'Senha deve ter ao menos 6 caracteres'),
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: 'Senhas não coincidem',
    path: ['confirmPassword'],
  });
type FormData = z.infer<typeof schema>;

export default function ConvitePage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const { setUser } = useAuth();
  const toast = useToast();

  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [checking, setChecking] = useState(true);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  useEffect(() => {
    getInviteByToken(params.token)
      .then(setInvite)
      .catch(() => setInvalid(true))
      .finally(() => setChecking(false));
  }, [params.token]);

  const onSubmit = async (data: FormData) => {
    try {
      await acceptInvite({ token: params.token, name: data.name, password: data.password });
      const user = await getMe();
      setUser(user);
      toast.success('Conta criada! Bem-vindo(a).');
      router.push(
        user.profileType === 'individual' ? '/app/pessoal/dashboard' : '/app/empresa/dashboard',
      );
    } catch (e) {
      toast.error(e instanceof ApiClientError ? e.message : 'Ocorreu um erro. Tente novamente.');
    }
  };

  if (checking) {
    return (
      <div className="w-full max-w-md text-center text-sm text-muted-foreground">Carregando...</div>
    );
  }

  if (invalid || !invite) {
    return (
      <div className="w-full max-w-md">
        <Card>
          <CardContent className="space-y-4 p-6 text-center">
            <p className="font-medium">Convite inválido ou expirado.</p>
            <p className="text-sm text-muted-foreground">
              Peça para a pessoa que te convidou gerar um novo link.
            </p>
            <Link href="/login" className="text-sm text-primary underline">
              Ir para o login
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-primary">Financial Vellun</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Você foi convidado(a)!</CardTitle>
          <CardDescription>
            {invite.ownerName} te convidou para organizar as finanças juntos. Crie sua senha para
            entrar.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-1">
              <Label>Email</Label>
              <Input value={invite.email} disabled />
            </div>
            <div className="space-y-1">
              <Label>Seu nome</Label>
              <Input placeholder="Seu nome" {...register('name')} />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>
            <div className="space-y-1">
              <Label>Senha</Label>
              <PasswordInput
                placeholder="Mínimo 6 caracteres"
                autoComplete="new-password"
                {...register('password')}
              />
              {errors.password && (
                <p className="text-xs text-destructive">{errors.password.message}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label>Confirmar senha</Label>
              <PasswordInput
                placeholder="Repita a senha"
                autoComplete="new-password"
                {...register('confirmPassword')}
              />
              {errors.confirmPassword && (
                <p className="text-xs text-destructive">{errors.confirmPassword.message}</p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'Criando conta...' : 'Entrar'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

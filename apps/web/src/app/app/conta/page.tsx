'use client';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/contexts/auth-context';
import { useToast } from '@/components/ui/toast';
import { updateMe } from '@/lib/auth';
import { PHONE_REGEX, maskPhone } from '@/lib/masks';

const schema = z.object({
  name: z.string().min(1, 'Nome obrigatório'),
  email: z.string().email('Email inválido'),
  phone: z.string().regex(PHONE_REGEX, 'Telefone inválido').optional().or(z.literal('')),
});
type FormData = z.infer<typeof schema>;

const profileTypeLabels: Record<string, string> = {
  individual: 'Pessoa Física',
  business: 'Pessoa Jurídica',
};

export default function MinhaContaPage() {
  const { user, setUser } = useAuth();
  const toast = useToast();

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    trigger,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', email: '', phone: '' },
  });

  useEffect(() => {
    if (user) {
      reset({ name: user.name, email: user.email, phone: user.phone ? maskPhone(user.phone) : '' });
    }
  }, [user, reset]);

  const onSubmit = async (data: FormData) => {
    try {
      const updated = await updateMe({
        name: data.name,
        email: data.email,
        phone: data.phone?.trim() ? data.phone.trim() : null,
      });
      setUser({ ...user!, ...updated });
      reset({ name: updated.name, email: updated.email, phone: updated.phone ?? '' });
      toast.success('Dados atualizados com sucesso.');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao atualizar dados');
    }
  };

  if (!user) return null;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Minha Conta</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Atualize suas informações pessoais e de contato.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dados da conta</CardTitle>
          <p className="text-xs text-muted-foreground">
            Tipo de perfil: {profileTypeLabels[user.profileType] ?? user.profileType}
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-1">
              <Label>Nome</Label>
              <Input placeholder="Seu nome" {...register('name')} />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>

            <div className="space-y-1">
              <Label>Email</Label>
              <Input
                type="email"
                placeholder="voce@exemplo.com"
                {...register('email', { onBlur: () => void trigger('email') })}
              />
              {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
            </div>

            <div className="space-y-1">
              <Label>Telefone</Label>
              <Input
                type="tel"
                placeholder="(00) 00000-0000"
                {...register('phone')}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const masked = maskPhone(e.target.value);
                  e.target.value = masked;
                  setValue('phone', masked, { shouldDirty: true });
                }}
              />
              {errors.phone && <p className="text-xs text-destructive">{errors.phone.message}</p>}
            </div>

            <div className="flex gap-2">
              <Button type="submit" disabled={isSubmitting || !isDirty}>
                {isSubmitting ? 'Salvando...' : 'Salvar alterações'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

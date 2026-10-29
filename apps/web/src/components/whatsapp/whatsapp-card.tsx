'use client';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { useToast } from '@/components/ui/toast';
import { WhatsappVerification } from '@/components/whatsapp/whatsapp-verification';
import { useAuth } from '@/contexts/auth-context';
import { ApiClientError } from '@/lib/api-client';
import { PHONE_REGEX, maskPhone } from '@/lib/masks';
import { unlinkWhatsapp } from '@/lib/whatsapp';

type Mode = 'view' | 'change' | 'verifying' | 'unlink';

interface VerificationTarget {
  phone?: string;
  currentPassword?: string;
}

const unlinkSchema = z.object({
  currentPassword: z.string().min(1, 'Informe a senha atual'),
});
type UnlinkFormData = z.infer<typeof unlinkSchema>;

/**
 * WhatsApp da conta em "Minha Conta". O número só muda depois de verificado:
 * trocar aqui gera um novo desafio, e o número antigo deixa de funcionar
 * quando o novo é confirmado. Trocar um número já verificado pede a senha.
 *
 * Desvincular também pede a senha. É o caminho de quem não reconhece o número
 * vinculado (a redefinição de senha não desfaz o vínculo).
 */
export function WhatsappCard() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('view');
  const [target, setTarget] = useState<VerificationTarget>({});
  const [unlinkError, setUnlinkError] = useState<string | null>(null);

  const verified = !!user?.whatsappVerified;

  const schema = z.object({
    phone: z.string().regex(PHONE_REGEX, 'Celular inválido ((00) 00000-0000)'),
    currentPassword: verified
      ? z.string().min(1, 'Informe a senha atual')
      : z.string().optional().or(z.literal('')),
  });
  type FormData = z.infer<typeof schema>;

  const {
    register,
    handleSubmit,
    setValue,
    reset,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { phone: '', currentPassword: '' },
  });

  const unlinkForm = useForm<UnlinkFormData>({
    resolver: zodResolver(unlinkSchema),
    defaultValues: { currentPassword: '' },
  });

  if (!user) return null;

  const startVerifying = (next: VerificationTarget) => {
    setTarget(next);
    setMode('verifying');
  };

  const cancel = () => {
    reset({ phone: '', currentPassword: '' });
    unlinkForm.reset({ currentPassword: '' });
    setUnlinkError(null);
    setMode('view');
  };

  const onSubmitUnlink = async (data: UnlinkFormData) => {
    setUnlinkError(null);
    try {
      await unlinkWhatsapp({ currentPassword: data.currentPassword });
      setUser({ ...user, whatsappVerified: false });
      toast.success('WhatsApp desvinculado.');
      cancel();
    } catch (e) {
      const passwordError =
        e instanceof ApiClientError
          ? e.fieldErrors.find((item) => item.field === 'currentPassword')
          : undefined;
      if (passwordError) {
        unlinkForm.setError(
          'currentPassword',
          { message: passwordError.message },
          { shouldFocus: true },
        );
        return;
      }
      setUnlinkError(
        e instanceof ApiClientError ? e.message : 'Não foi possível desvincular. Tente de novo.',
      );
    }
  };

  const onSubmitChange = (data: FormData) =>
    startVerifying({
      phone: data.phone,
      currentPassword: data.currentPassword?.trim() ? data.currentPassword : undefined,
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">WhatsApp</CardTitle>
        <p className="text-xs text-muted-foreground">
          O número verificado é o que o bot reconhece para registrar seus lançamentos.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {mode === 'view' && (
          <>
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-sm font-medium">{user.phone ?? 'Nenhum número'}</span>
              <span
                className={`w-fit rounded-full px-2 py-0.5 text-xs font-medium ${
                  verified ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
                }`}
              >
                {verified ? 'Verificado' : 'Não verificado'}
              </span>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              {!verified && user.phone && (
                <Button
                  type="button"
                  className="w-full sm:w-auto"
                  onClick={() => startVerifying({})}
                >
                  Verificar WhatsApp
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={() => setMode('change')}
              >
                Trocar número
              </Button>
              {verified && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full text-destructive hover:text-destructive sm:w-auto"
                  onClick={() => setMode('unlink')}
                >
                  Desvincular
                </Button>
              )}
            </div>
          </>
        )}

        {mode === 'unlink' && (
          <form noValidate onSubmit={unlinkForm.handleSubmit(onSubmitUnlink)} className="space-y-4">
            <p className="text-sm">
              O número <span className="font-medium">{user.phone}</span> vai deixar de registrar
              lançamentos na sua conta. Para voltar a usar o WhatsApp, é só verificar o número de
              novo.
            </p>
            <div className="space-y-1">
              <Label htmlFor="unlink-current-password">Senha atual</Label>
              <PasswordInput
                id="unlink-current-password"
                placeholder="Sua senha"
                autoComplete="current-password"
                aria-invalid={!!unlinkForm.formState.errors.currentPassword}
                {...unlinkForm.register('currentPassword')}
              />
              {unlinkForm.formState.errors.currentPassword && (
                <p className="text-xs text-destructive">
                  {unlinkForm.formState.errors.currentPassword.message}
                </p>
              )}
            </div>
            {unlinkError && (
              <p className="text-sm text-destructive" role="alert">
                {unlinkError}
              </p>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={cancel}>
                Cancelar
              </Button>
              <Button
                type="submit"
                variant="destructive"
                className="w-full sm:w-auto"
                disabled={unlinkForm.formState.isSubmitting}
              >
                {unlinkForm.formState.isSubmitting ? 'Desvinculando…' : 'Desvincular WhatsApp'}
              </Button>
            </div>
          </form>
        )}

        {mode === 'change' && (
          <form onSubmit={handleSubmit(onSubmitChange)} className="space-y-4">
            <div className="space-y-1">
              <Label>Novo celular com WhatsApp</Label>
              <Input
                type="tel"
                inputMode="tel"
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
            {verified && (
              <div className="space-y-1">
                <Label>Senha atual</Label>
                <PasswordInput
                  placeholder="Sua senha"
                  autoComplete="current-password"
                  {...register('currentPassword')}
                />
                {errors.currentPassword && (
                  <p className="text-xs text-destructive">{errors.currentPassword.message}</p>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              O número atual continua funcionando até o novo ser verificado.
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={cancel}>
                Cancelar
              </Button>
              <Button type="submit" className="w-full sm:w-auto">
                Gerar código
              </Button>
            </div>
          </form>
        )}

        {mode === 'verifying' && (
          <>
            <WhatsappVerification
              phone={target.phone}
              currentPassword={target.currentPassword}
              onVerified={() =>
                setUser({
                  ...user,
                  whatsappVerified: true,
                  phone: target.phone ?? user.phone,
                })
              }
            />
            <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={cancel}>
              Voltar
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

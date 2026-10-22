'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { LinkIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { useToast } from '@/components/ui/toast';
import { textLink } from '@/components/marketing/styles';
import { useAuth } from '@/contexts/auth-context';
import { ApiClientError } from '@/lib/api-client';
import { resetPassword } from '@/lib/auth';
import { apiErrorMessages } from './api-errors';
import { FormAlert } from './form-alert';
import { FormField, fieldControlClass } from './form-field';

/** Formato do token gerado pela API: 32 bytes em hexadecimal. */
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

const schema = z
  .object({
    newPassword: z.string().min(8, 'Senha deve ter ao menos 8 caracteres'),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'As senhas não coincidem',
    path: ['confirmPassword'],
  });
type FormData = z.infer<typeof schema>;

function InvalidLink({ message }: { message?: string }) {
  return (
    <div className="mx-auto w-full max-w-[420px]">
      <LinkIcon aria-hidden className="h-10 w-10 text-danger" />
      <h1 className="mt-4 text-3xl font-bold tracking-tight text-ink">Link inválido</h1>
      <p className="mt-3 text-base text-ink-muted" role="alert">
        {message ??
          'Este link de redefinição está incompleto ou já expirou. Cada link vale por pouco tempo e só pode ser usado uma vez.'}
      </p>
      <Button asChild size="xl" className="mt-8 w-full hover:bg-primary-hover">
        <Link href="/esqueci-senha">Pedir um novo link</Link>
      </Button>
      <p className="mt-4 text-center text-base text-ink-muted">
        <Link href="/login" className={textLink}>
          Voltar para o login
        </Link>
      </p>
    </div>
  );
}

/** Nova senha a partir do link do e-mail (`/redefinir-senha?token=…`). */
export function ResetPasswordForm() {
  const router = useRouter();
  const toast = useToast();
  const { setUser } = useAuth();
  const token = useSearchParams().get('token') ?? '';

  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [linkError, setLinkError] = useState<string | null>(null);
  // Mantém o botão travado entre a troca aceita e a ida para o login.
  const [redirecting, setRedirecting] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema), mode: 'onTouched' });

  if (!TOKEN_PATTERN.test(token)) return <InvalidLink />;
  if (linkError) return <InvalidLink message={linkError} />;

  const busy = isSubmitting || redirecting;

  const onSubmit = async (data: FormData) => {
    setFormErrors([]);
    try {
      await resetPassword({ token, newPassword: data.newPassword });
      // A troca encerra todas as sessões, inclusive a deste navegador.
      setUser(null);
      setRedirecting(true);
      toast.success('Senha redefinida! Entre com a senha nova.');
      router.replace('/login');
    } catch (e) {
      if (e instanceof ApiClientError) {
        const tokenError = e.fieldErrors.find((item) => item.field === 'token');
        if (tokenError) {
          setLinkError(tokenError.message);
          return;
        }
        const passwordError = e.fieldErrors.find((item) => item.field === 'newPassword');
        if (passwordError) {
          setError('newPassword', { message: passwordError.message }, { shouldFocus: true });
          return;
        }
      }
      setFormErrors(apiErrorMessages(e));
    }
  };

  return (
    <div className="mx-auto w-full max-w-[420px]">
      <h1 className="text-3xl font-bold tracking-tight text-ink">Criar senha nova</h1>
      <p className="mt-2 text-base text-ink-muted">
        Ao salvar, você sai da conta em todos os aparelhos e entra de novo com a senha nova.
      </p>

      <form noValidate onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-5">
        <FormField
          id="reset-password"
          label="Senha nova"
          hint="Mínimo de 8 caracteres."
          error={errors.newPassword?.message}
        >
          {(control) => (
            <PasswordInput
              {...control}
              autoComplete="new-password"
              className={fieldControlClass}
              {...register('newPassword')}
            />
          )}
        </FormField>
        <FormField
          id="reset-confirm-password"
          label="Confirme a senha nova"
          error={errors.confirmPassword?.message}
        >
          {(control) => (
            <PasswordInput
              {...control}
              autoComplete="new-password"
              className={fieldControlClass}
              {...register('confirmPassword')}
            />
          )}
        </FormField>

        <FormAlert messages={formErrors} />

        <Button type="submit" size="xl" disabled={busy} className="w-full hover:bg-primary-hover">
          {busy ? 'Salvando…' : 'Salvar senha nova'}
        </Button>
      </form>
    </div>
  );
}

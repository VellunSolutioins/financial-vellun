'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { textLink } from '@/components/marketing/styles';
import { forgotPassword } from '@/lib/auth';
import { apiErrorMessages } from './api-errors';
import { FormAlert } from './form-alert';
import { FormField, fieldControlClass } from './form-field';

const schema = z.object({
  email: z.string().trim().email('Email inválido'),
});
type FormData = z.infer<typeof schema>;

/**
 * Pedido do link de redefinição. Depois do envio, a tela diz o mesmo para
 * qualquer e-mail — com conta ou sem —, como a API.
 */
export function ForgotPasswordForm() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const sentHeadingRef = useRef<HTMLHeadingElement>(null);

  const {
    register,
    handleSubmit,
    trigger,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  // Leitor de tela: ao trocar de estado, o foco vai para o novo título.
  useEffect(() => {
    if (sentTo) sentHeadingRef.current?.focus();
  }, [sentTo]);

  const onSubmit = async (data: FormData) => {
    setFormErrors([]);
    try {
      await forgotPassword(data.email);
      setSentTo(data.email);
    } catch (e) {
      setFormErrors(apiErrorMessages(e));
    }
  };

  const tryAgain = () => {
    setSentTo(null);
    // Espera o formulário voltar à tela antes de focar.
    requestAnimationFrame(() => setFocus('email'));
  };

  if (sentTo) {
    return (
      <div className="mx-auto w-full max-w-[420px]">
        <MailCheck aria-hidden className="h-10 w-10 text-primary" />
        <h1
          ref={sentHeadingRef}
          tabIndex={-1}
          className="mt-4 text-3xl font-bold tracking-tight text-ink outline-none"
        >
          Confira seu email
        </h1>
        <p className="mt-3 text-base text-ink-muted" role="status">
          Se houver uma conta com <strong className="break-all text-ink">{sentTo}</strong>, enviamos
          um link para você criar uma senha nova. O link vale por 1 hora.
        </p>
        <p className="mt-4 text-base text-ink-muted">
          Não chegou em alguns minutos? Veja a caixa de spam ou{' '}
          <button type="button" onClick={tryAgain} className={textLink}>
            peça de novo
          </button>
          .
        </p>
        <Button asChild size="xl" variant="outline" className="mt-8 w-full">
          <Link href="/login">Voltar para o login</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[420px]">
      <h1 className="text-3xl font-bold tracking-tight text-ink">Esqueceu a senha?</h1>
      <p className="mt-2 text-base text-ink-muted">
        Informe o email da sua conta. Enviaremos um link para você criar uma senha nova.
      </p>

      <form noValidate onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-5">
        <FormField id="forgot-email" label="Email" error={errors.email?.message}>
          {(control) => (
            <Input
              {...control}
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              className={fieldControlClass}
              {...register('email', { onBlur: () => void trigger('email') })}
            />
          )}
        </FormField>

        <FormAlert messages={formErrors} />

        <Button
          type="submit"
          size="xl"
          disabled={isSubmitting}
          className="w-full hover:bg-primary-hover"
        >
          {isSubmitting ? 'Enviando…' : 'Enviar link'}
        </Button>
      </form>

      <p className="mt-4 text-center text-base text-ink-muted">
        Lembrou a senha?{' '}
        <Link href="/login" className={textLink}>
          Entrar
        </Link>
      </p>
    </div>
  );
}

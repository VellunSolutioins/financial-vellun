'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { focusRing, textLink } from '@/components/marketing/styles';
import { useAuth } from '@/contexts/auth-context';
import { register as registerUser, login } from '@/lib/auth';
import { mapSignupErrors } from './api-errors';
import { FormAlert } from './form-alert';
import {
  FIELD_ORDER,
  SIGNUP_DEFAULTS,
  signupSchema,
  toRegisterPayload,
  type SignupFormValues,
} from './signup-schema';
import { SignupFields } from './signup-fields';

const inlineLink = `rounded font-medium text-primary underline underline-offset-4 hover:text-primary-hover ${focusRing}`;

const LOGIN_AFTER_SIGNUP_ERROR =
  'Sua conta foi criada, mas não conseguimos entrar automaticamente. Acesse a página Entrar com seu email e senha.';

/**
 * Cadastro só com os dados pessoais. CPF e endereço ficam para "Minha Conta":
 * são exigidos ao assinar, não para entrar no app.
 */
export function SignupForm() {
  const router = useRouter();
  const { setUser } = useAuth();
  const toast = useToast();

  const form = useForm<SignupFormValues>({
    resolver: zodResolver(signupSchema),
    defaultValues: SIGNUP_DEFAULTS,
    mode: 'onTouched',
  });
  const {
    handleSubmit,
    setError,
    setFocus,
    formState: { isSubmitting },
  } = form;

  const [formErrors, setFormErrors] = useState<string[]>([]);
  // Mantém o botão travado entre a conta criada e a troca de página.
  const [redirecting, setRedirecting] = useState(false);
  const busy = isSubmitting || redirecting;

  const onValid = async (data: SignupFormValues) => {
    setFormErrors([]);

    try {
      await registerUser(toRegisterPayload(data));
    } catch (e) {
      const { fields, general } = mapSignupErrors(e);
      const invalid = FIELD_ORDER.filter((field) => fields[field]);
      for (const field of invalid) setError(field, { type: 'server', message: fields[field] });
      setFormErrors(general);
      if (invalid.length > 0) setFocus(invalid[0]);
      return;
    }

    try {
      const user = await login({ email: data.email, password: data.password });
      setUser(user);
      setRedirecting(true);
      toast.success('Conta criada com sucesso!');
      // Próximo passo: provar a posse do WhatsApp para ligá-lo à conta.
      router.push('/app/verificar-whatsapp');
    } catch {
      // Reenviar o cadastro aqui só devolveria "Email já cadastrado".
      setFormErrors([LOGIN_AFTER_SIGNUP_ERROR]);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[520px]">
      <h1 className="text-3xl font-bold tracking-tight text-ink">Crie sua conta</h1>
      <p className="mt-2 text-base text-ink-muted">
        Preencha seus dados e, em seguida, verifique seu WhatsApp para começar a lançar.
      </p>
      <p className="text-base text-ink-muted">
        Já tem conta?{' '}
        <Link href="/login" className={textLink}>
          Entrar
        </Link>
      </p>

      <form noValidate className="mt-8" onSubmit={handleSubmit(onValid)}>
        <SignupFields form={form} />

        <div className="mt-6 space-y-4">
          <FormAlert messages={formErrors} />
          {/* Nova aba: abrir na mesma apagaria o que já foi preenchido. */}
          <p className="text-sm leading-relaxed text-ink-muted">
            Ao criar sua conta, você concorda com os{' '}
            <a href="/termos" target="_blank" rel="noopener" className={inlineLink}>
              Termos de Serviço
              <span className="sr-only"> (abre em nova aba)</span>
            </a>{' '}
            e a{' '}
            <a href="/privacidade" target="_blank" rel="noopener" className={inlineLink}>
              Política de Privacidade
              <span className="sr-only"> (abre em nova aba)</span>
            </a>
            .
          </p>
          <Button type="submit" size="xl" disabled={busy} className="w-full hover:bg-primary-hover">
            {busy ? 'Criando conta…' : 'Criar conta'}
          </Button>
        </div>
      </form>
    </div>
  );
}

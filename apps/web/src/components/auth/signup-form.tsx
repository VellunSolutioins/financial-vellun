'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm, type FieldErrors } from 'react-hook-form';
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
  SIGNUP_STEPS,
  STEP_FIELDS,
  signupSchema,
  stepOf,
  toRegisterPayload,
  type SignupField,
  type SignupFormValues,
  type SignupStep,
} from './signup-schema';
import { SignupStepAccount } from './signup-step-account';
import { SignupStepDetails } from './signup-step-details';
import { StepIndicator } from './step-indicator';

const inlineLink = `rounded font-medium text-primary underline underline-offset-4 hover:text-primary-hover ${focusRing}`;

const LOGIN_AFTER_SIGNUP_ERROR =
  'Sua conta foi criada, mas não conseguimos entrar automaticamente. Acesse a página Entrar com seu email e senha.';

/**
 * Cadastro em duas etapas sobre um único formulário. As duas etapas ficam
 * montadas e a inativa só é escondida: os valores (inclusive as senhas) vivem
 * apenas na memória do formulário, e o gerenciador de senhas ainda enxerga os
 * campos no envio final. `POST /auth/register` só é chamado na etapa 2.
 */
export function SignupForm() {
  const router = useRouter();
  const { setUser } = useAuth();
  const toast = useToast();

  const form = useForm<SignupFormValues>({
    resolver: zodResolver(signupSchema),
    defaultValues: SIGNUP_DEFAULTS,
    mode: 'onTouched',
    // O foco no primeiro erro é feito aqui, porque ele pode estar na outra etapa.
    shouldFocusError: false,
  });
  const {
    handleSubmit,
    trigger,
    getFieldState,
    setError,
    setFocus,
    formState: { isSubmitting },
  } = form;

  const [step, setStep] = useState<SignupStep>(0);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  // Mantém os botões travados entre a conta criada e a troca de página.
  const [redirecting, setRedirecting] = useState(false);
  const busy = isSubmitting || redirecting;

  // O foco só pode ir a um campo depois que a etapa dele estiver visível.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [focusRequest, setFocusRequest] = useState<SignupField | 'heading' | null>(null);
  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest === 'heading') headingRef.current?.focus();
    else setFocus(focusRequest);
    setFocusRequest(null);
  }, [focusRequest, setFocus]);

  const goToStep = (next: SignupStep) => {
    setStep(next);
    setFocusRequest('heading');
  };

  const focusField = (field: SignupField) => {
    setStep(stepOf(field));
    setFocusRequest(field);
  };

  const handleContinue = async () => {
    setFormErrors([]);
    if (await trigger(STEP_FIELDS[0])) {
      goToStep(1);
      return;
    }
    const firstInvalid = STEP_FIELDS[0].find((field) => getFieldState(field).invalid);
    if (firstInvalid) focusField(firstInvalid);
  };

  const onInvalid = (errors: FieldErrors<SignupFormValues>) => {
    const firstInvalid = FIELD_ORDER.find((field) => errors[field]);
    if (firstInvalid) focusField(firstInvalid);
  };

  const onValid = async (data: SignupFormValues) => {
    setFormErrors([]);

    try {
      await registerUser(toRegisterPayload(data));
    } catch (e) {
      const { fields, general } = mapSignupErrors(e);
      const invalid = FIELD_ORDER.filter((field) => fields[field]);
      for (const field of invalid) setError(field, { type: 'server', message: fields[field] });
      setFormErrors(general);
      if (invalid.length > 0) focusField(invalid[0]);
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

      <div className="mt-4">
        <StepIndicator steps={SIGNUP_STEPS} current={step} />
      </div>

      <form
        noValidate
        className="mt-8"
        onSubmit={(e) => {
          // Enter e o botão principal seguem a etapa atual: na primeira, só avança.
          if (step === 0) {
            e.preventDefault();
            void handleContinue();
          } else {
            void handleSubmit(onValid, onInvalid)(e);
          }
        }}
      >
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-xl font-semibold text-ink focus:outline-none"
        >
          <span className="sr-only">
            Etapa {step + 1} de {SIGNUP_STEPS.length}:{' '}
          </span>
          {SIGNUP_STEPS[step]}
        </h2>

        <div className="mt-5">
          <div hidden={step !== 0}>
            <SignupStepAccount form={form} />
          </div>
          <div hidden={step !== 1}>
            <SignupStepDetails form={form} />
          </div>
        </div>

        <div className="mt-6 space-y-4">
          <FormAlert messages={formErrors} />
          {step === 0 ? (
            <Button type="submit" size="xl" className="w-full hover:bg-primary-hover">
              Continuar
            </Button>
          ) : (
            <>
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
              <div className="flex flex-col-reverse gap-3 sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  size="xl"
                  disabled={busy}
                  onClick={() => goToStep(0)}
                >
                  Voltar
                </Button>
                <Button
                  type="submit"
                  size="xl"
                  disabled={busy}
                  className="hover:bg-primary-hover sm:flex-1"
                >
                  {busy ? 'Criando conta…' : 'Criar conta'}
                </Button>
              </div>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

'use client';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { maskPhone } from '@/lib/masks';
import { FormField, fieldControlClass } from './form-field';
import type { SignupFormApi } from './signup-schema';

/** Etapa 1 — "Seus dados". */
export function SignupStepAccount({ form }: { form: SignupFormApi }) {
  const {
    register,
    setValue,
    formState: { errors },
  } = form;

  return (
    <div className="space-y-5">
      <FormField id="signup-name" label="Nome completo" error={errors.name?.message}>
        {(control) => (
          <Input
            {...control}
            autoComplete="name"
            className={fieldControlClass}
            {...register('name')}
          />
        )}
      </FormField>
      <FormField id="signup-email" label="Email" error={errors.email?.message}>
        {(control) => (
          <Input
            {...control}
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            className={fieldControlClass}
            {...register('email')}
          />
        )}
      </FormField>
      <FormField
        id="signup-phone"
        label="Celular com WhatsApp"
        hint="Usaremos este número para vincular seu WhatsApp à conta."
        error={errors.phone?.message}
      >
        {(control) => (
          <Input
            {...control}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="(00) 00000-0000"
            className={fieldControlClass}
            {...register('phone')}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              const masked = maskPhone(e.target.value);
              e.target.value = masked;
              setValue('phone', masked, { shouldDirty: true, shouldValidate: !!errors.phone });
            }}
          />
        )}
      </FormField>
      <FormField
        id="signup-password"
        label="Senha"
        hint="Mínimo de 8 caracteres."
        error={errors.password?.message}
      >
        {(control) => (
          <PasswordInput
            {...control}
            autoComplete="new-password"
            className={fieldControlClass}
            {...register('password')}
          />
        )}
      </FormField>
      <FormField
        id="signup-confirm-password"
        label="Confirmar senha"
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
    </div>
  );
}

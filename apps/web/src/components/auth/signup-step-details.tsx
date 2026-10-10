'use client';
import { Input } from '@/components/ui/input';
import { maskCep, maskCpf } from '@/lib/masks';
import { FormField, fieldControlClass } from './form-field';
import type { SignupFormApi } from './signup-schema';

const legendClass = 'text-sm font-semibold uppercase tracking-wide text-ink-muted';

/** Etapa 2 — "Documento e endereço". */
export function SignupStepDetails({ form }: { form: SignupFormApi }) {
  const {
    register,
    setValue,
    formState: { errors },
  } = form;

  return (
    <div className="space-y-8">
      <fieldset className="space-y-5">
        <legend className={legendClass}>Documento</legend>
        <FormField id="signup-cpf" label="CPF" error={errors.cpf?.message}>
          {(control) => (
            <Input
              {...control}
              inputMode="numeric"
              placeholder="000.000.000-00"
              className={fieldControlClass}
              {...register('cpf')}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                const masked = maskCpf(e.target.value);
                e.target.value = masked;
                setValue('cpf', masked, { shouldDirty: true, shouldValidate: !!errors.cpf });
              }}
            />
          )}
        </FormField>
        <FormField
          id="signup-birth-date"
          label="Data de nascimento"
          optional
          error={errors.birthDate?.message}
        >
          {(control) => (
            <Input
              {...control}
              type="date"
              autoComplete="bday"
              className={fieldControlClass}
              {...register('birthDate')}
            />
          )}
        </FormField>
      </fieldset>

      <fieldset className="space-y-5">
        <legend className={legendClass}>Endereço</legend>
        <FormField id="signup-postal-code" label="CEP" error={errors.postalCode?.message}>
          {(control) => (
            <Input
              {...control}
              inputMode="numeric"
              autoComplete="postal-code"
              placeholder="00000-000"
              className={fieldControlClass}
              {...register('postalCode')}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                const masked = maskCep(e.target.value);
                e.target.value = masked;
                setValue('postalCode', masked, {
                  shouldDirty: true,
                  shouldValidate: !!errors.postalCode,
                });
              }}
            />
          )}
        </FormField>
        <FormField id="signup-street" label="Logradouro" error={errors.street?.message}>
          {(control) => (
            <Input
              {...control}
              autoComplete="address-line1"
              placeholder="Rua / Avenida"
              className={fieldControlClass}
              {...register('street')}
            />
          )}
        </FormField>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <FormField
            id="signup-address-number"
            label="Número"
            error={errors.addressNumber?.message}
          >
            {(control) => (
              <Input
                {...control}
                inputMode="numeric"
                className={fieldControlClass}
                {...register('addressNumber')}
              />
            )}
          </FormField>
          <FormField
            id="signup-complement"
            label="Complemento"
            optional
            error={errors.complement?.message}
          >
            {(control) => (
              <Input
                {...control}
                autoComplete="address-line2"
                placeholder="Apto, bloco..."
                className={fieldControlClass}
                {...register('complement')}
              />
            )}
          </FormField>
        </div>
        <FormField id="signup-neighborhood" label="Bairro" error={errors.neighborhood?.message}>
          {(control) => (
            <Input
              {...control}
              autoComplete="address-level3"
              className={fieldControlClass}
              {...register('neighborhood')}
            />
          )}
        </FormField>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
          <FormField
            id="signup-city"
            label="Cidade"
            error={errors.city?.message}
            className="sm:col-span-2"
          >
            {(control) => (
              <Input
                {...control}
                autoComplete="address-level2"
                className={fieldControlClass}
                {...register('city')}
              />
            )}
          </FormField>
          <FormField id="signup-state" label="UF" error={errors.state?.message}>
            {(control) => (
              <Input
                {...control}
                autoComplete="address-level1"
                autoCapitalize="characters"
                maxLength={2}
                className={fieldControlClass}
                {...register('state')}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const uf = e.target.value
                    .replace(/[^A-Za-z]/g, '')
                    .toUpperCase()
                    .slice(0, 2);
                  e.target.value = uf;
                  setValue('state', uf, { shouldDirty: true, shouldValidate: !!errors.state });
                }}
              />
            )}
          </FormField>
        </div>
      </fieldset>
    </div>
  );
}

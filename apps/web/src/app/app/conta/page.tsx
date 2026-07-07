'use client';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/contexts/auth-context';
import { useToast } from '@/components/ui/toast';
import {
  getProfile,
  updateBusinessProfile,
  updateIndividualProfile,
  updateMe,
  updatePassword,
} from '@/lib/auth';
import {
  PHONE_REGEX,
  CEP_REGEX,
  CPF_REGEX,
  CNPJ_REGEX,
  maskPhone,
  maskCep,
  maskCpf,
  maskCnpj,
  isValidCpf,
  isValidCnpj,
} from '@/lib/masks';

const schema = z.object({
  name: z.string().min(1, 'Nome obrigatório'),
  email: z.string().email('Email inválido'),
  phone: z.string().regex(PHONE_REGEX, 'Telefone inválido').optional().or(z.literal('')),
  postalCode: z.string().regex(CEP_REGEX, 'CEP inválido (00000-000)').optional().or(z.literal('')),
  street: z.string().optional().or(z.literal('')),
  addressNumber: z.string().optional().or(z.literal('')),
  complement: z.string().optional().or(z.literal('')),
  neighborhood: z.string().optional().or(z.literal('')),
  city: z.string().optional().or(z.literal('')),
  state: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'UF (2 letras)')
    .optional()
    .or(z.literal('')),
});
type FormData = z.infer<typeof schema>;

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Informe a senha atual'),
    newPassword: z.string().min(8, 'A nova senha deve ter ao menos 8 caracteres'),
    confirmNewPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmNewPassword, {
    message: 'As senhas não coincidem',
    path: ['confirmNewPassword'],
  });
type PasswordFormData = z.infer<typeof passwordSchema>;

const individualSchema = z.object({
  cpf: z
    .string()
    .regex(CPF_REGEX, 'CPF inválido (000.000.000-00)')
    .refine(isValidCpf, 'CPF inválido (dígito verificador)'),
  birthDate: z.string().optional().or(z.literal('')),
});
type IndividualFormData = z.infer<typeof individualSchema>;

const businessSchema = z.object({
  companyName: z.string().min(2, 'Razão social obrigatória'),
  tradeName: z.string().optional().or(z.literal('')),
  cnpj: z
    .string()
    .regex(CNPJ_REGEX, 'CNPJ inválido (00.000.000/0000-00)')
    .refine(isValidCnpj, 'CNPJ inválido (dígito verificador)'),
});
type BusinessFormData = z.infer<typeof businessSchema>;

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
    defaultValues: {
      name: '',
      email: '',
      phone: '',
      postalCode: '',
      street: '',
      addressNumber: '',
      complement: '',
      neighborhood: '',
      city: '',
      state: '',
    },
  });

  useEffect(() => {
    if (user) {
      reset({
        name: user.name,
        email: user.email,
        phone: user.phone ? maskPhone(user.phone) : '',
        postalCode: user.postalCode ? maskCep(user.postalCode) : '',
        street: user.street ?? '',
        addressNumber: user.addressNumber ?? '',
        complement: user.complement ?? '',
        neighborhood: user.neighborhood ?? '',
        city: user.city ?? '',
        state: user.state ?? '',
      });
    }
  }, [user, reset]);

  const {
    register: registerPwd,
    handleSubmit: handleSubmitPwd,
    reset: resetPwd,
    formState: { errors: errorsPwd, isSubmitting: isSubmittingPwd },
  } = useForm<PasswordFormData>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmNewPassword: '' },
  });

  // ── Documento (CPF/CNPJ) — carregado de /users/me/profile ──
  const {
    register: registerInd,
    handleSubmit: handleSubmitInd,
    reset: resetInd,
    setValue: setValueInd,
    formState: { errors: errorsInd, isSubmitting: isSubmittingInd, isDirty: isDirtyInd },
  } = useForm<IndividualFormData>({
    resolver: zodResolver(individualSchema),
    defaultValues: { cpf: '', birthDate: '' },
  });

  const {
    register: registerBiz,
    handleSubmit: handleSubmitBiz,
    reset: resetBiz,
    setValue: setValueBiz,
    formState: { errors: errorsBiz, isSubmitting: isSubmittingBiz, isDirty: isDirtyBiz },
  } = useForm<BusinessFormData>({
    resolver: zodResolver(businessSchema),
    defaultValues: { companyName: '', tradeName: '', cnpj: '' },
  });

  useEffect(() => {
    let active = true;
    getProfile()
      .then((profile) => {
        if (!active) return;
        if (profile.individualProfile) {
          resetInd({
            cpf: maskCpf(profile.individualProfile.cpf),
            birthDate: profile.individualProfile.birthDate?.slice(0, 10) ?? '',
          });
        }
        if (profile.businessProfile) {
          resetBiz({
            companyName: profile.businessProfile.companyName,
            tradeName: profile.businessProfile.tradeName ?? '',
            cnpj: maskCnpj(profile.businessProfile.cnpj),
          });
        }
      })
      .catch(() => {
        /* perfil ainda não preenchido — formulário começa vazio */
      });
    return () => {
      active = false;
    };
  }, [resetInd, resetBiz]);

  const onSubmitIndividual = async (data: IndividualFormData) => {
    try {
      const updated = await updateIndividualProfile({
        cpf: data.cpf,
        birthDate: data.birthDate?.trim() ? data.birthDate : undefined,
      });
      resetInd({
        cpf: maskCpf(updated.cpf),
        birthDate: updated.birthDate?.slice(0, 10) ?? '',
      });
      toast.success('Documento atualizado com sucesso.');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao atualizar documento');
    }
  };

  const onSubmitBusiness = async (data: BusinessFormData) => {
    try {
      const updated = await updateBusinessProfile({
        companyName: data.companyName,
        tradeName: data.tradeName?.trim() ? data.tradeName : undefined,
        cnpj: data.cnpj,
      });
      resetBiz({
        companyName: updated.companyName,
        tradeName: updated.tradeName ?? '',
        cnpj: maskCnpj(updated.cnpj),
      });
      toast.success('Documento atualizado com sucesso.');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao atualizar documento');
    }
  };

  const onSubmit = async (data: FormData) => {
    try {
      const updated = await updateMe({
        name: data.name,
        email: data.email,
        phone: data.phone?.trim() ? data.phone.trim() : null,
        postalCode: data.postalCode?.trim() || undefined,
        street: data.street?.trim() || undefined,
        addressNumber: data.addressNumber?.trim() || undefined,
        complement: data.complement?.trim() || undefined,
        neighborhood: data.neighborhood?.trim() || undefined,
        city: data.city?.trim() || undefined,
        state: data.state?.trim() ? data.state.trim().toUpperCase() : undefined,
      });
      setUser({ ...user!, ...updated });
      reset({
        name: updated.name,
        email: updated.email,
        phone: updated.phone ? maskPhone(updated.phone) : '',
        postalCode: updated.postalCode ? maskCep(updated.postalCode) : '',
        street: updated.street ?? '',
        addressNumber: updated.addressNumber ?? '',
        complement: updated.complement ?? '',
        neighborhood: updated.neighborhood ?? '',
        city: updated.city ?? '',
        state: updated.state ?? '',
      });
      toast.success('Dados atualizados com sucesso.');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao atualizar dados');
    }
  };

  const onSubmitPassword = async (data: PasswordFormData) => {
    try {
      await updatePassword({
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
      });
      resetPwd({ currentPassword: '', newPassword: '', confirmNewPassword: '' });
      toast.success('Senha atualizada com sucesso.');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao atualizar senha');
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

            <div className="border-t pt-4">
              <p className="text-sm font-medium">Endereço de cobrança</p>
              <p className="text-xs text-muted-foreground">
                Necessário para assinar um plano pago.
              </p>
            </div>

            <div className="space-y-1">
              <Label>CEP</Label>
              <Input
                inputMode="numeric"
                placeholder="00000-000"
                {...register('postalCode')}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const masked = maskCep(e.target.value);
                  e.target.value = masked;
                  setValue('postalCode', masked, { shouldDirty: true });
                }}
              />
              {errors.postalCode && (
                <p className="text-xs text-destructive">{errors.postalCode.message}</p>
              )}
            </div>

            <div className="space-y-1">
              <Label>Logradouro</Label>
              <Input placeholder="Rua / Avenida" {...register('street')} />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Número</Label>
                <Input inputMode="numeric" placeholder="123" {...register('addressNumber')} />
              </div>
              <div className="space-y-1">
                <Label>Complemento (opcional)</Label>
                <Input placeholder="Apto, bloco..." {...register('complement')} />
              </div>
            </div>

            <div className="space-y-1">
              <Label>Bairro</Label>
              <Input placeholder="Centro" {...register('neighborhood')} />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-1 sm:col-span-2">
                <Label>Cidade</Label>
                <Input placeholder="Curitiba" {...register('city')} />
              </div>
              <div className="space-y-1">
                <Label>UF</Label>
                <Input
                  placeholder="PR"
                  maxLength={2}
                  {...register('state')}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    const uf = e.target.value
                      .replace(/[^A-Za-z]/g, '')
                      .toUpperCase()
                      .slice(0, 2);
                    e.target.value = uf;
                    setValue('state', uf, { shouldDirty: true });
                  }}
                />
                {errors.state && <p className="text-xs text-destructive">{errors.state.message}</p>}
              </div>
            </div>

            <div className="flex gap-2">
              <Button type="submit" disabled={isSubmitting || !isDirty}>
                {isSubmitting ? 'Salvando...' : 'Salvar alterações'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Documento</CardTitle>
          <p className="text-xs text-muted-foreground">
            Usado na emissão de cobranças. Mantenha-o correto para conseguir assinar.
          </p>
        </CardHeader>
        <CardContent>
          {user.profileType === 'individual' ? (
            <form onSubmit={handleSubmitInd(onSubmitIndividual)} className="space-y-4">
              <div className="space-y-1">
                <Label>CPF</Label>
                <Input
                  inputMode="numeric"
                  placeholder="000.000.000-00"
                  {...registerInd('cpf')}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    const masked = maskCpf(e.target.value);
                    e.target.value = masked;
                    setValueInd('cpf', masked, { shouldDirty: true });
                  }}
                />
                {errorsInd.cpf && (
                  <p className="text-xs text-destructive">{errorsInd.cpf.message}</p>
                )}
              </div>
              <div className="space-y-1">
                <Label>Data de nascimento (opcional)</Label>
                <Input type="date" {...registerInd('birthDate')} />
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={isSubmittingInd || !isDirtyInd}>
                  {isSubmittingInd ? 'Salvando...' : 'Salvar documento'}
                </Button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleSubmitBiz(onSubmitBusiness)} className="space-y-4">
              <div className="space-y-1">
                <Label>Razão social</Label>
                <Input placeholder="Empresa LTDA" {...registerBiz('companyName')} />
                {errorsBiz.companyName && (
                  <p className="text-xs text-destructive">{errorsBiz.companyName.message}</p>
                )}
              </div>
              <div className="space-y-1">
                <Label>Nome fantasia (opcional)</Label>
                <Input placeholder="Nome fantasia" {...registerBiz('tradeName')} />
              </div>
              <div className="space-y-1">
                <Label>CNPJ</Label>
                <Input
                  inputMode="numeric"
                  placeholder="00.000.000/0000-00"
                  {...registerBiz('cnpj')}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    const masked = maskCnpj(e.target.value);
                    e.target.value = masked;
                    setValueBiz('cnpj', masked, { shouldDirty: true });
                  }}
                />
                {errorsBiz.cnpj && (
                  <p className="text-xs text-destructive">{errorsBiz.cnpj.message}</p>
                )}
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={isSubmittingBiz || !isDirtyBiz}>
                  {isSubmittingBiz ? 'Salvando...' : 'Salvar documento'}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Alterar senha</CardTitle>
          <p className="text-xs text-muted-foreground">
            Informe a senha atual para definir uma nova.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmitPwd(onSubmitPassword)} className="space-y-4">
            <div className="space-y-1">
              <Label>Senha atual</Label>
              <PasswordInput
                placeholder="Sua senha atual"
                autoComplete="current-password"
                {...registerPwd('currentPassword')}
              />
              {errorsPwd.currentPassword && (
                <p className="text-xs text-destructive">{errorsPwd.currentPassword.message}</p>
              )}
            </div>

            <div className="space-y-1">
              <Label>Nova senha</Label>
              <PasswordInput
                placeholder="Mínimo 8 caracteres"
                autoComplete="new-password"
                {...registerPwd('newPassword')}
              />
              {errorsPwd.newPassword && (
                <p className="text-xs text-destructive">{errorsPwd.newPassword.message}</p>
              )}
            </div>

            <div className="space-y-1">
              <Label>Confirmar nova senha</Label>
              <PasswordInput
                placeholder="Repita a nova senha"
                autoComplete="new-password"
                {...registerPwd('confirmNewPassword')}
              />
              {errorsPwd.confirmNewPassword && (
                <p className="text-xs text-destructive">{errorsPwd.confirmNewPassword.message}</p>
              )}
            </div>

            <div className="flex gap-2">
              <Button type="submit" disabled={isSubmittingPwd}>
                {isSubmittingPwd ? 'Salvando...' : 'Atualizar senha'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

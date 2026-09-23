'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/contexts/auth-context';
import { useToast } from '@/components/ui/toast';
import { register as registerUser, login } from '@/lib/auth';
import { ApiClientError } from '@/lib/api-client';
import {
  CPF_REGEX,
  CNPJ_REGEX,
  PHONE_REGEX,
  CEP_REGEX,
  maskCpf,
  maskCnpj,
  maskPhone,
  maskCep,
  isValidCpf,
  isValidCnpj,
} from '@/lib/masks';

const schema = z
  .object({
    name: z.string().min(2, 'Nome deve ter ao menos 2 caracteres'),
    email: z.string().email('Email inválido'),
    phone: z.string().regex(PHONE_REGEX, 'Celular inválido ((00) 00000-0000)'),
    postalCode: z.string().regex(CEP_REGEX, 'CEP inválido (00000-000)'),
    street: z.string().min(2, 'Logradouro obrigatório'),
    addressNumber: z.string().min(1, 'Número obrigatório'),
    complement: z.string().optional().or(z.literal('')),
    neighborhood: z.string().min(2, 'Bairro obrigatório'),
    city: z.string().min(2, 'Cidade obrigatória'),
    state: z.string().regex(/^[A-Za-z]{2}$/, 'UF (2 letras)'),
    password: z.string().min(8, 'Senha deve ter ao menos 8 caracteres'),
    confirmPassword: z.string(),
    profileType: z.enum(['individual', 'business'], { required_error: 'Selecione um tipo' }),
    cpf: z.string().optional().or(z.literal('')),
    birthDate: z.string().optional().or(z.literal('')),
    companyName: z.string().optional().or(z.literal('')),
    tradeName: z.string().optional().or(z.literal('')),
    cnpj: z.string().optional().or(z.literal('')),
  })
  .superRefine((d, ctx) => {
    if (d.password !== d.confirmPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Senhas não coincidem',
        path: ['confirmPassword'],
      });
    }
    if (d.profileType === 'individual') {
      if (!d.cpf || !CPF_REGEX.test(d.cpf)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CPF inválido (000.000.000-00)',
          path: ['cpf'],
        });
      } else if (!isValidCpf(d.cpf)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CPF inválido (dígito verificador)',
          path: ['cpf'],
        });
      }
    } else if (d.profileType === 'business') {
      if (!d.companyName || d.companyName.trim().length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Razão social obrigatória',
          path: ['companyName'],
        });
      }
      if (!d.cnpj || !CNPJ_REGEX.test(d.cnpj)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CNPJ inválido (00.000.000/0000-00)',
          path: ['cnpj'],
        });
      } else if (!isValidCnpj(d.cnpj)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CNPJ inválido (dígito verificador)',
          path: ['cnpj'],
        });
      }
    }
  });
type FormData = z.infer<typeof schema>;

export default function CadastroPage() {
  const router = useRouter();
  const { setUser } = useAuth();
  const toast = useToast();

  const {
    register,
    handleSubmit,
    trigger,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  const profileType = watch('profileType');

  const onSubmit = async (data: FormData) => {
    try {
      await registerUser({
        name: data.name,
        email: data.email,
        phone: data.phone,
        password: data.password,
        postalCode: data.postalCode,
        street: data.street,
        addressNumber: data.addressNumber,
        complement: data.complement?.trim() ? data.complement : undefined,
        neighborhood: data.neighborhood,
        city: data.city,
        state: data.state.toUpperCase(),
        profileType: data.profileType,
        ...(data.profileType === 'individual'
          ? { cpf: data.cpf, birthDate: data.birthDate?.trim() ? data.birthDate : undefined }
          : {
              companyName: data.companyName,
              tradeName: data.tradeName?.trim() ? data.tradeName : undefined,
              cnpj: data.cnpj,
            }),
      });
      const user = await login({ email: data.email, password: data.password });
      setUser(user);
      toast.success('Conta criada com sucesso!');
      // Próximo passo: provar a posse do WhatsApp para ligá-lo à conta.
      router.push('/app/verificar-whatsapp');
    } catch (e) {
      toast.error(e instanceof ApiClientError ? e.message : 'Ocorreu um erro. Tente novamente.');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Criar conta</CardTitle>
        <CardDescription>Crie sua conta no Financial Vellun</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1">
            <Label>Nome completo</Label>
            <Input placeholder="Seu nome" {...register('name')} />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>
          <div className="space-y-1">
            <Label>Email</Label>
            <Input
              type="email"
              placeholder="seu@email.com"
              {...register('email', { onBlur: () => void trigger('email') })}
            />
            {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
          </div>
          <div className="space-y-1">
            <Label>Celular com WhatsApp</Label>
            <Input
              inputMode="tel"
              placeholder="(19) 99999-9999"
              {...register('phone')}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                const masked = maskPhone(e.target.value);
                e.target.value = masked;
                setValue('phone', masked, { shouldDirty: true });
              }}
            />
            {errors.phone && <p className="text-xs text-destructive">{errors.phone.message}</p>}
          </div>

          {/* Endereço de cobrança (obrigatório para assinaturas) */}
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
            {errors.street && <p className="text-xs text-destructive">{errors.street.message}</p>}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Número</Label>
              <Input inputMode="numeric" placeholder="123" {...register('addressNumber')} />
              {errors.addressNumber && (
                <p className="text-xs text-destructive">{errors.addressNumber.message}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label>Complemento (opcional)</Label>
              <Input placeholder="Apto, bloco..." {...register('complement')} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Bairro</Label>
            <Input placeholder="Centro" {...register('neighborhood')} />
            {errors.neighborhood && (
              <p className="text-xs text-destructive">{errors.neighborhood.message}</p>
            )}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-1 sm:col-span-2">
              <Label>Cidade</Label>
              <Input placeholder="Curitiba" {...register('city')} />
              {errors.city && <p className="text-xs text-destructive">{errors.city.message}</p>}
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

          <div className="space-y-1">
            <Label>Senha</Label>
            <PasswordInput
              placeholder="Mínimo 8 caracteres"
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
          <div className="space-y-1">
            <Label>Tipo de conta</Label>
            <Select {...register('profileType')}>
              <option value="">Selecione...</option>
              <option value="individual">Pessoa Física</option>
              <option value="business">Pessoa Jurídica</option>
            </Select>
            {errors.profileType && (
              <p className="text-xs text-destructive">{errors.profileType.message}</p>
            )}
          </div>

          {profileType === 'individual' && (
            <>
              <div className="space-y-1">
                <Label>CPF</Label>
                <Input
                  inputMode="numeric"
                  placeholder="000.000.000-00"
                  {...register('cpf')}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    const masked = maskCpf(e.target.value);
                    e.target.value = masked;
                    setValue('cpf', masked, { shouldDirty: true });
                  }}
                />
                {errors.cpf && <p className="text-xs text-destructive">{errors.cpf.message}</p>}
              </div>
              <div className="space-y-1">
                <Label>Data de nascimento (opcional)</Label>
                <Input type="date" {...register('birthDate')} />
                {errors.birthDate && (
                  <p className="text-xs text-destructive">{errors.birthDate.message}</p>
                )}
              </div>
            </>
          )}

          {profileType === 'business' && (
            <>
              <div className="space-y-1">
                <Label>Razão social</Label>
                <Input placeholder="Empresa LTDA" {...register('companyName')} />
                {errors.companyName && (
                  <p className="text-xs text-destructive">{errors.companyName.message}</p>
                )}
              </div>
              <div className="space-y-1">
                <Label>Nome fantasia (opcional)</Label>
                <Input placeholder="Nome fantasia" {...register('tradeName')} />
                {errors.tradeName && (
                  <p className="text-xs text-destructive">{errors.tradeName.message}</p>
                )}
              </div>
              <div className="space-y-1">
                <Label>CNPJ</Label>
                <Input
                  inputMode="numeric"
                  placeholder="00.000.000/0000-00"
                  {...register('cnpj')}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    const masked = maskCnpj(e.target.value);
                    e.target.value = masked;
                    setValue('cnpj', masked, { shouldDirty: true });
                  }}
                />
                {errors.cnpj && <p className="text-xs text-destructive">{errors.cnpj.message}</p>}
              </div>
            </>
          )}

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Criando conta...' : 'Criar conta'}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            Já tem conta?{' '}
            <Link href="/login" className="text-primary underline">
              Entrar
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

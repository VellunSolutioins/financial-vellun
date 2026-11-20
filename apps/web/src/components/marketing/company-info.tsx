import { cn } from '@/lib/utils';

/**
 * Dados da empresa responsável pelo Zeloo. A Meta exige que o site mostre
 * razão social, CNPJ, endereço e telefone para aprovar o app do WhatsApp; esses
 * valores replicam o rodapé de faboci.com.br e devem continuar idênticos a ele
 * (só o nome fantasia é o do produto, Zeloo, em vez de FabTech).
 */
export const COMPANY = {
  tradeName: 'Zeloo',
  legalName: '59.880.707 BRUNO EDUARDO FABOCI',
  cnpj: '59.880.707/0001-82',
  address: 'Rua Francisco Arruda Melo, 07, Jardim América, Mogi Guaçu / São Paulo - CEP 13848-014',
  phone: '(19) 98950-8042',
} as const;

const phoneHref = `tel:+55${COMPANY.phone.replace(/\D/g, '')}`;

/** Bloco de identificação da empresa, para os rodapés públicos. */
export function CompanyInfo({ className }: { className?: string }) {
  return (
    <address className={cn('text-xs not-italic leading-relaxed text-ink-muted', className)}>
      <p>
        <strong className="font-semibold text-ink">{COMPANY.tradeName}</strong>
        <span aria-hidden> · </span>
        <span className="break-words">{COMPANY.legalName}</span>
      </p>
      <p>CNPJ: {COMPANY.cnpj}</p>
      <p className="break-words">{COMPANY.address}</p>
      <p>
        Telefone:{' '}
        <a href={phoneHref} className="hover:text-ink hover:underline">
          {COMPANY.phone}
        </a>
      </p>
    </address>
  );
}

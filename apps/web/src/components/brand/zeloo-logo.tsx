import Image from 'next/image';
import { cn } from '@/lib/utils';

export const ZELOO_SLOGAN = 'Seu dinheiro merece cuidado.';

/**
 * Arquivos em `public/marca`, recortados do kit em `docs/marca/zeloo` sem a
 * margem de respiro (o espaçamento fica com o layout). A altura vem da classe e
 * a largura acompanha a proporção.
 */
const LOGO = { src: '/marca/zeloo-logo.svg', width: 1768, height: 477 };
const SYMBOL = { src: '/marca/zeloo-simbolo.svg', width: 512, height: 477 };
const APP_ICON = { src: '/marca/zeloo-icone.svg', width: 512, height: 512 };

type LogoProps = {
  className?: string;
  /** Texto alternativo; `''` quando o nome já está escrito ao lado. */
  alt?: string;
  priority?: boolean;
};

/** Símbolo e nome. Uso padrão, sempre que houver espaço. */
export function ZelooLogo({ className, alt = 'Zeloo', priority }: LogoProps) {
  return <Image {...LOGO} alt={alt} priority={priority} className={cn('h-7 w-auto', className)} />;
}

/** Só o "Z", para onde o logo completo não cabe (ex.: menu recolhido). */
export function ZelooSymbol({ className, alt = 'Zeloo', priority }: LogoProps) {
  return (
    <Image {...SYMBOL} alt={alt} priority={priority} className={cn('h-7 w-auto', className)} />
  );
}

/** Ícone de app (Z branco no quadrado azul), para avatares. */
export function ZelooAppIcon({ className, alt = 'Zeloo' }: Omit<LogoProps, 'priority'>) {
  return <Image {...APP_ICON} alt={alt} className={cn('h-9 w-9', className)} />;
}

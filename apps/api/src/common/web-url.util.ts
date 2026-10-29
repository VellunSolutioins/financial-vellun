import { ConfigService } from '@nestjs/config';

const DEFAULT_WEB_URL = 'http://localhost:3000';

/**
 * Origem do frontend (`WEB_URL`), sem barra no final, para montar links
 * (`${webUrl(config)}/login`). Um lugar só para ler a variável: validar a URL
 * ou aceitar várias origens no futuro muda aqui.
 */
export function webUrl(config: ConfigService): string {
  return (config.get<string>('WEB_URL')?.trim() || DEFAULT_WEB_URL).replace(/\/+$/, '');
}

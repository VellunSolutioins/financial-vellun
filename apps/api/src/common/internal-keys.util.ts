import { ConfigService } from '@nestjs/config';

/**
 * Chaves da comunicação interna entre API e agente, uma por direção (plano de
 * segurança, S2). Com uma chave só, quem a obtivesse de um dos lados falava
 * com os dois: chamava a API como se fosse o agente e o agente como se fosse a
 * API. Separadas, vazar uma não abre a outra, e cada uma gira sozinha.
 *
 * Convivência: enquanto `INTERNAL_API_KEY` existir, ela continua aceita e é a
 * chave enviada quando a da direção não está configurada. Para migrar: definir
 * as chaves por direção nos dois serviços, fazer o deploy e só então remover
 * `INTERNAL_API_KEY`.
 *
 * As constantes abaixo são **nomes de variáveis de ambiente**, não chaves.
 */
export const AGENT_TO_API_KEY_ENV = 'INTERNAL_API_KEY_AGENT_TO_API';
export const API_TO_AGENT_KEY_ENV = 'INTERNAL_API_KEY_API_TO_AGENT';
export const LEGACY_INTERNAL_KEY_ENV = 'INTERNAL_API_KEY';

type InternalKeyEnv = typeof AGENT_TO_API_KEY_ENV | typeof API_TO_AGENT_KEY_ENV;

function read(config: ConfigService, name: string): string | undefined {
  const value = config.get<string>(name)?.trim();
  return value || undefined;
}

/** Chaves aceitas numa direção: a própria e, durante a migração, a antiga. */
export function acceptedInternalKeys(config: ConfigService, direction: InternalKeyEnv): string[] {
  return [read(config, direction), read(config, LEGACY_INTERNAL_KEY_ENV)].filter(
    (key): key is string => Boolean(key),
  );
}

/** Chave enviada numa direção: a própria, ou a antiga enquanto ela existir. */
export function outgoingInternalKey(config: ConfigService, direction: InternalKeyEnv): string {
  const key = read(config, direction) ?? read(config, LEGACY_INTERNAL_KEY_ENV);
  if (!key) {
    throw new Error(`Configure ${direction} (ou ${LEGACY_INTERNAL_KEY_ENV}, durante a migração)`);
  }
  return key;
}

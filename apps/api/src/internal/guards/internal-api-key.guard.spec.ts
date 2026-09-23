import { UnauthorizedException } from '@nestjs/common';

import { InternalApiKeyGuard } from './internal-api-key.guard';

const LEGACY = 'l'.repeat(24);
const AGENT_TO_API = 'a'.repeat(24);
const API_TO_AGENT = 'b'.repeat(24);

function context(provided?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { 'x-internal-api-key': provided } }),
    }),
  } as any;
}

function guardWith(values: Record<string, string | undefined>) {
  const config = { get: (key: string) => values[key] } as any;
  return new InternalApiKeyGuard(config);
}

describe('InternalApiKeyGuard', () => {
  describe('só com a chave antiga', () => {
    const guard = guardWith({ INTERNAL_API_KEY: LEGACY });

    it('libera com a chave correta', () => {
      expect(guard.canActivate(context(LEGACY))).toBe(true);
    });

    it('rejeita chave incorreta', () => {
      expect(() => guard.canActivate(context('wrong'))).toThrow(UnauthorizedException);
    });

    it('rejeita ausência de chave', () => {
      expect(() => guard.canActivate(context(undefined))).toThrow(UnauthorizedException);
    });
  });

  describe('com chaves por direção', () => {
    it('aceita a chave agente→API e, na convivência, a antiga', () => {
      const guard = guardWith({
        INTERNAL_API_KEY: LEGACY,
        INTERNAL_API_KEY_AGENT_TO_API: AGENT_TO_API,
      });

      expect(guard.canActivate(context(AGENT_TO_API))).toBe(true);
      expect(guard.canActivate(context(LEGACY))).toBe(true);
    });

    it('recusa a chave da outra direção', () => {
      // Quem tem a chave que a API usa para chamar o agente não chama a API.
      const guard = guardWith({
        INTERNAL_API_KEY_AGENT_TO_API: AGENT_TO_API,
        INTERNAL_API_KEY_API_TO_AGENT: API_TO_AGENT,
      });

      expect(() => guard.canActivate(context(API_TO_AGENT))).toThrow(UnauthorizedException);
    });

    it('depois da migração, a chave antiga deixa de valer', () => {
      const guard = guardWith({ INTERNAL_API_KEY_AGENT_TO_API: AGENT_TO_API });

      expect(() => guard.canActivate(context(LEGACY))).toThrow(UnauthorizedException);
    });
  });
});

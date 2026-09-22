import { isAllowedWebOrigin } from './http-origin.util';

const PREVIEW = 'https://financial-vellun-web-git-feat-x-vellun-s-projects.vercel.app';

describe('isAllowedWebOrigin', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  describe('em produção', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      process.env.WEB_URL = 'https://app.vellun.com.br/';
      process.env.WEB_ALLOWED_ORIGINS = 'https://outro.vellun.com.br, https://mais.vellun.com.br';
    });

    it('aceita as origens configuradas, exatas e sem barra final', () => {
      expect(isAllowedWebOrigin('https://app.vellun.com.br')).toBe(true);
      expect(isAllowedWebOrigin('https://mais.vellun.com.br')).toBe(true);
      expect(isAllowedWebOrigin('https://financial-vellun-web.vercel.app')).toBe(true);
    });

    it('recusa preview de branch e localhost', () => {
      expect(isAllowedWebOrigin(PREVIEW)).toBe(false);
      expect(isAllowedWebOrigin('http://localhost:3000')).toBe(false);
    });

    it('recusa domínio parecido', () => {
      expect(isAllowedWebOrigin('https://app.vellun.com.br.evil.example')).toBe(false);
    });
  });

  describe('fora de produção', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
      delete process.env.WEB_URL;
      delete process.env.WEB_ALLOWED_ORIGINS;
    });

    it('aceita localhost e previews de branch', () => {
      expect(isAllowedWebOrigin('http://localhost:3000')).toBe(true);
      expect(isAllowedWebOrigin(PREVIEW)).toBe(true);
    });

    it('recusa origem ausente ou desconhecida', () => {
      expect(isAllowedWebOrigin(undefined)).toBe(false);
      expect(isAllowedWebOrigin('https://evil.example')).toBe(false);
    });
  });
});

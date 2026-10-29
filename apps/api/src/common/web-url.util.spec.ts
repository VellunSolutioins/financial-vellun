import { ConfigService } from '@nestjs/config';

import { webUrl } from './web-url.util';

function config(value: string | undefined): ConfigService {
  return { get: () => value } as unknown as ConfigService;
}

describe('webUrl', () => {
  it('tira a barra final', () => {
    expect(webUrl(config('https://app.example.com//'))).toBe('https://app.example.com');
  });

  it('cai no localhost quando ausente ou vazio', () => {
    expect(webUrl(config(undefined))).toBe('http://localhost:3000');
    expect(webUrl(config('  '))).toBe('http://localhost:3000');
  });
});

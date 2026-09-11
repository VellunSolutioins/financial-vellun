import {
  MAX_ATTEMPTS,
  RETRY_BUCKETS_SECONDS,
  nextRetryAt,
  totalRetryWindowSeconds,
} from './webhook-retry.policy';

const agora = new Date('2026-09-11T12:00:00.000Z');

function segundosDepois(data: Date | null): number | null {
  return data ? (data.getTime() - agora.getTime()) / 1000 : null;
}

describe('política de retry de webhook', () => {
  it('espalha as tentativas pelos buckets, na ordem', () => {
    const esperas = [1, 2, 3, 4].map((tentativas) =>
      segundosDepois(nextRetryAt(tentativas, agora)),
    );

    expect(esperas).toEqual([30, 120, 600, 1800]);
  });

  it('a última tentativa não tem próxima: esgotou', () => {
    expect(nextRetryAt(MAX_ATTEMPTS, agora)).toBeNull();
    expect(nextRetryAt(MAX_ATTEMPTS + 3, agora)).toBeNull();
  });

  it('cobre horas, não segundos', () => {
    // O backoff antigo (`2^n * 500ms`) esgotava o evento em ~7,5 s — antes de
    // uma indisponibilidade de PSP ter qualquer chance de passar.
    expect(totalRetryWindowSeconds()).toBeGreaterThan(2 * 60 * 60);
  });

  it('nenhum intervalo é menor que um ciclo do cron', () => {
    // O agendamento é varrido de minuto em minuto: um bucket de 500 ms só
    // produziria a ilusão de urgência.
    for (const bucket of RETRY_BUCKETS_SECONDS) {
      expect(bucket).toBeGreaterThanOrEqual(30);
    }
  });

  it('os intervalos crescem', () => {
    const crescentes = [...RETRY_BUCKETS_SECONDS].sort((a, b) => a - b);
    expect([...RETRY_BUCKETS_SECONDS]).toEqual(crescentes);
  });

  it('uma contagem impossível ainda agenda, em vez de esgotar por engano', () => {
    expect(segundosDepois(nextRetryAt(0, agora))).toBe(30);
  });
});

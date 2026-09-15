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
  it('usa TODOS os buckets, na ordem — inclusive o último', () => {
    // O spec antigo só exercitava as tentativas 1 a 4, e por isso não viu que a
    // quinta falha esgotava o evento sem nunca esperar o bucket de 2 h.
    const esperas = RETRY_BUCKETS_SECONDS.map((_, i) => segundosDepois(nextRetryAt(i + 1, agora)));

    expect(esperas).toEqual([30, 120, 600, 1800, 7200]);
  });

  it('só esgota depois de a espera do último bucket ter acontecido', () => {
    const ultimaAgendada = RETRY_BUCKETS_SECONDS.length;

    expect(nextRetryAt(ultimaAgendada, agora)).not.toBeNull();
    expect(MAX_ATTEMPTS).toBe(ultimaAgendada + 1);
    expect(nextRetryAt(MAX_ATTEMPTS, agora)).toBeNull();
    expect(nextRetryAt(MAX_ATTEMPTS + 3, agora)).toBeNull();
  });

  it('a janela anunciada é a janela que acontece', () => {
    // `totalRetryWindowSeconds` soma todos os buckets. Com o off-by-one, a soma
    // prometia ~2 h 50 enquanto a janela real era de ~42 min. Aqui a soma é
    // reconstruída a partir do que `nextRetryAt` de fato agenda.
    let janelaReal = 0;
    for (let tentativas = 1; ; tentativas += 1) {
      const proxima = nextRetryAt(tentativas, agora);
      if (proxima === null) break;
      janelaReal += segundosDepois(proxima)!;
    }

    expect(janelaReal).toBe(totalRetryWindowSeconds());
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

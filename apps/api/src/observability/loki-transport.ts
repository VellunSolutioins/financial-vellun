/**
 * Envio de logs para o Loki, via `loki.source.api` do Alloy.
 *
 * **Por que a aplicação empurra em vez de alguém ler o stdout:** o Railway não
 * tem log drain — a documentação é explícita, e as alternativas são um forwarder
 * que leia stdout de outro container (o acoplamento que queríamos evitar) ou a
 * própria aplicação emitir. Escolhida a segunda: o processo conhece o endereço do
 * Alloy, não a credencial do Grafana Cloud, e o log sai já estruturado e
 * correlacionado, sem depender de parsear texto.
 *
 * Três invariantes, na ordem de importância:
 *
 * 1. **Nunca interrompe a aplicação.** Falha de rede, 500 do Alloy, DNS errado:
 *    nada disso propaga. Observabilidade que derruba o que observa é pior que
 *    nenhuma.
 * 2. **Nunca bloqueia.** As linhas vão para um buffer em memória e saem em lote
 *    numa tarefa própria. Um `await` no caminho do log tornaria a latência da API
 *    dependente da latência do Loki.
 * 3. **Nunca cresce sem limite.** Com o Alloy fora, o buffer descartaria memória
 *    até derrubar o processo — então há teto, e o descarte é contado e visível.
 *
 * O stdout continua recebendo tudo. Este transporte é adicional, não substituto:
 * se ele falhar, o log ainda está no Railway.
 */

const DEFAULT_FLUSH_INTERVAL_MS = 2_000;
const DEFAULT_MAX_BUFFER = 1_000;
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_TIMEOUT_MS = 5_000;

/** Silencia o aviso de falha para não gerar uma linha por tentativa. */
const WARN_INTERVAL_MS = 60_000;

/**
 * Teto do backoff entre tentativas.
 *
 * Sem backoff, um Alloy fora significa uma tentativa a cada 2 s indefinidamente —
 * e um Alloy **sob pressão** significa ser martelado a taxa fixa por cada réplica
 * exatamente quando ele menos aguenta. O intervalo dobra a cada falha consecutiva
 * até este teto, e volta ao normal no primeiro sucesso.
 */
const MAX_BACKOFF_MS = 60_000;

export interface LokiTransportOptions {
  /** Base do `loki.source.api` do Alloy, ex.: `http://alloy.railway.internal:3100`. */
  url: string;
  /** Labels do stream. Mantenha poucos e fechados: é cardinalidade no Loki. */
  labels: Record<string, string>;
  flushIntervalMs?: number;
  maxBuffer?: number;
  batchSize?: number;
  timeoutMs?: number;
}

interface Entry {
  /** Epoch em nanossegundos, como o Loki exige. */
  timestampNs: string;
  line: string;
}

export class LokiTransport {
  private readonly pushUrl: string;
  private readonly labels: Record<string, string>;
  private readonly flushIntervalMs: number;
  private readonly maxBuffer: number;
  private readonly batchSize: number;
  private readonly timeoutMs: number;

  private buffer: Entry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private stopped = false;

  /** Linhas descartadas por buffer cheio. Exposto como métrica. */
  private droppedCount = 0;
  private lastWarnAt = 0;
  private consecutiveFailures = 0;

  constructor(options: LokiTransportOptions) {
    this.pushUrl = `${options.url.replace(/\/+$/, '')}/loki/api/v1/push`;
    this.labels = options.labels;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  get pending(): number {
    return this.buffer.length;
  }

  /**
   * Enfileira uma linha já serializada. Retorna imediatamente.
   *
   * Descarta a **mais antiga** quando o buffer enche, não a nova: durante um
   * incidente a linha recente é a que explica o que está acontecendo agora.
   */
  push(line: string): void {
    if (this.stopped) return;

    if (this.buffer.length >= this.maxBuffer) {
      this.buffer.shift();
      this.droppedCount += 1;
      this.warnThrottled(
        `Buffer do Loki cheio (${this.maxBuffer}); ${this.droppedCount} linha(s) descartada(s).`,
      );
    }

    this.buffer.push({ timestampNs: nowNs(), line });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null || this.stopped) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.nextDelayMs());

    // `unref` para que o timer não segure o processo aberto no shutdown.
    this.timer.unref?.();
  }

  /** Intervalo normal, dobrando a cada falha consecutiva até o teto. */
  private nextDelayMs(): number {
    if (this.consecutiveFailures === 0) return this.flushIntervalMs;

    const backoff = this.flushIntervalMs * 2 ** this.consecutiveFailures;
    return Math.min(backoff, MAX_BACKOFF_MS);
  }

  /** Envia o que está no buffer. Nunca lança. */
  async flush(): Promise<void> {
    // Um flush por vez: dois em paralelo poderiam publicar a mesma linha duas
    // vezes ou reordenar o lote.
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;

    try {
      while (this.buffer.length > 0) {
        const batch = this.buffer.splice(0, this.batchSize);
        const enviado = await this.send(batch);
        if (!enviado) {
          // Devolve o lote à frente do buffer para a próxima tentativa. Se o
          // buffer já estourou nesse meio-tempo, o teto acima corta o excesso.
          this.buffer.unshift(...batch);
          this.consecutiveFailures += 1;
          break;
        }
        this.consecutiveFailures = 0;
      }
    } finally {
      this.flushing = false;
      if (this.buffer.length > 0) this.schedule();
    }
  }

  private async send(batch: Entry[]): Promise<boolean> {
    const body = JSON.stringify({
      streams: [
        {
          stream: this.labels,
          values: batch.map((entry) => [entry.timestampNs, entry.line]),
        },
      ],
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.pushUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        this.warnThrottled(`Loki recusou o lote (HTTP ${response.status}).`);
        // 4xx não melhora com retry (lote malformado, label inválido) e reter
        // seguraria o buffer para sempre; 5xx e 429 valem nova tentativa.
        return response.status >= 400 && response.status < 500 && response.status !== 429;
      }
      return true;
    } catch (error) {
      this.warnThrottled(`Falha ao enviar logs ao Loki: ${(error as Error).name}`);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Para de aceitar linhas novas e descarrega o que resta. Chamado no shutdown.
   *
   * A ordem importa: fechar a entrada **antes** do flush garante que o laço do
   * flush termina. Aceitando linhas novas durante o flush, um serviço que loga no
   * próprio shutdown poderia realimentar o buffer indefinidamente.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /**
   * Encerra sem tentar enviar o que resta.
   *
   * Diferente de {@link stop}: aqui o buffer é abandonado de propósito. Serve para
   * o caso em que esperar o flush é pior que perder as linhas — um teste, ou um
   * encerramento em que o destino está comprovadamente fora e o `stop` só
   * gastaria o tempo de timeout.
   */
  dispose(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = [];
  }

  /**
   * Avisa no stderr, no máximo uma vez por minuto.
   *
   * Sem o limite, o Alloy fora geraria uma linha de aviso por linha de log — e o
   * aviso sobre não conseguir logar afogaria o log.
   */
  private warnThrottled(message: string): void {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    process.stderr.write(`[LokiTransport] ${message}\n`);
  }
}

function nowNs(): string {
  // `Date.now()` tem resolução de ms; o Loki quer ns. Multiplicar é honesto —
  // `hrtime` não é comparável a epoch sem uma âncora, e a precisão extra não
  // ajudaria a ordenar linhas geradas no mesmo milissegundo.
  return `${BigInt(Date.now()) * 1_000_000n}`;
}

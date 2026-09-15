"""Envio de logs para o Loki, via ``loki.source.api`` do Alloy.

Contraparte do ``LokiTransport`` da API. O motivo de a aplicacao empurrar em vez
de alguem ler o stdout esta documentado em
``infra/observability/alloy/config.alloy``: **o Railway nao tem log drain**, e as
alternativas eram um forwarder lendo stdout de outro container (o acoplamento que
queriamos evitar) ou o proprio processo emitir.

Tres invariantes, na ordem de importancia:

1. **Nunca interrompe a aplicacao.** Um ``logging.Handler`` que levanta excecao
   quebra o codigo que estava logando — que costuma ser um caminho de erro.
   ``emit`` engole tudo.
2. **Nunca bloqueia.** As linhas vao para uma fila e saem em lote numa thread
   propria. Um POST sincrono dentro do ``emit`` faria a latencia do processamento
   depender da latencia do Loki.
3. **Nunca cresce sem limite.** Com o Alloy fora, a fila consumiria memoria ate
   derrubar o processo. Ha teto, e o descarte e contado.

O stdout continua recebendo tudo: este handler e adicional.
"""

from __future__ import annotations

import atexit
import json
import logging
import queue
import threading
import time
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

#: Teto da fila. Cheia, descarta a **mais antiga**: durante um incidente a linha
#: recente e a que explica o que esta acontecendo agora.
MAX_QUEUE = 1000
BATCH_SIZE = 200
FLUSH_INTERVAL_SECONDS = 2.0
TIMEOUT_SECONDS = 5.0

#: Intervalo minimo entre avisos de falha. Sem ele, o Alloy fora geraria um aviso
#: por linha — e o aviso sobre nao conseguir logar afogaria o log.
WARN_INTERVAL_SECONDS = 60.0


class LokiHandler(logging.Handler):
    """Handler que enfileira a linha formatada e envia em lote."""

    def __init__(self, url: str, labels: dict[str, str]) -> None:
        super().__init__()
        self._url = f"{url.rstrip('/')}/loki/api/v1/push"
        self._labels = labels
        self._queue: queue.Queue[tuple[str, str]] = queue.Queue(maxsize=MAX_QUEUE)
        self._stop = threading.Event()
        self._dropped = 0
        self._last_warn = 0.0

        # `daemon=True` para que a thread nao impeca o processo de encerrar; o
        # `atexit` abaixo garante o ultimo flush.
        self._thread = threading.Thread(
            target=self._run, name="loki-handler", daemon=True
        )
        self._thread.start()
        atexit.register(self.close)

    @property
    def dropped(self) -> int:
        return self._dropped

    def emit(self, record: logging.LogRecord) -> None:
        try:
            line = self.format(record)
            timestamp_ns = str(int(record.created * 1_000_000_000))
            try:
                self._queue.put_nowait((timestamp_ns, line))
            except queue.Full:
                # Abre espaco descartando a mais antiga.
                try:
                    self._queue.get_nowait()
                    self._dropped += 1
                    self._queue.put_nowait((timestamp_ns, line))
                except (queue.Empty, queue.Full):
                    self._dropped += 1
                self._warn(f"Fila do Loki cheia; {self._dropped} linha(s) descartada(s).")
        except Exception:  # noqa: BLE001 - handler nunca derruba quem loga
            pass

    def _run(self) -> None:
        while not self._stop.is_set():
            self._stop.wait(FLUSH_INTERVAL_SECONDS)
            self._flush()
        # Ultimo flush apos o sinal de parada.
        self._flush()

    def _flush(self) -> None:
        batch: list[tuple[str, str]] = []
        while len(batch) < BATCH_SIZE:
            try:
                batch.append(self._queue.get_nowait())
            except queue.Empty:
                break

        if not batch:
            return

        if not self._send(batch):
            # Devolve o que couber; o resto e perdido de forma contada, e nao
            # acumulado indefinidamente.
            for item in batch:
                try:
                    self._queue.put_nowait(item)
                except queue.Full:
                    self._dropped += 1

    def _send(self, batch: list[tuple[str, str]]) -> bool:
        payload = json.dumps(
            {"streams": [{"stream": self._labels, "values": [list(i) for i in batch]}]}
        ).encode()

        request = urllib.request.Request(
            self._url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                return 200 <= response.status < 300
        except urllib.error.HTTPError as exc:
            self._warn(f"Loki recusou o lote (HTTP {exc.code}).")
            # 4xx nao melhora com retry (lote malformado, label invalido) e reter
            # seguraria a fila para sempre; 5xx e 429 valem nova tentativa.
            return 400 <= exc.code < 500 and exc.code != 429
        except Exception as exc:  # noqa: BLE001
            self._warn(f"Falha ao enviar logs ao Loki: {type(exc).__name__}")
            return False

    def _warn(self, message: str) -> None:
        now = time.monotonic()
        if now - self._last_warn < WARN_INTERVAL_SECONDS:
            return
        self._last_warn = now
        # `print` em vez de `logger.warning`: usar o logging aqui pode reentrar
        # neste mesmo handler.
        print(f"[LokiHandler] {message}", flush=True)

    def close(self) -> None:
        if self._stop.is_set():
            return
        self._stop.set()
        self._thread.join(timeout=TIMEOUT_SECONDS + FLUSH_INTERVAL_SECONDS)
        super().close()

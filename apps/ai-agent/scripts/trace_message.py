"""Rastreia **uma** mensagem pelo pipeline, salto a salto.

Envia um webhook de texto no formato real da Meta e narra cada etapa conforme
ela acontece — webhook, consumer de entrada, agrupamento, processamento,
resposta — com o tempo desde o envio. No fim, confere no Postgres a mensagem
recebida, a resposta registrada e o último lançamento do usuário.

    python scripts/trace_message.py
    python scripts/trace_message.py "recebi 3000 de salário"
    python scripts/trace_message.py "gastei 50" --phone +5511999999999
    python scripts/trace_message.py "oi" --phone +5541977775555   # não vinculado

É o contrário do ``loadtest.py``: uma mensagem, lida em detalhe, para responder
"onde parou?". As etapas vêm dos contadores de ``GET /metrics.json`` (lidos a
cada 100 ms), que são **por processo** — com ``RUN_CONSUMERS_IN_API=false``,
aponte ``--agent`` para a porta do worker. A leitura de Redis e Postgres usa
``docker exec`` nos containers do ``infra/docker``; ``--no-docker`` pula as duas.

> Cria um lançamento de verdade e, com ``WHATSAPP_PROVIDER=cloud-api``, manda
> uma resposta de verdade. Use ``log`` e um telefone de teste.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

import httpx

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

AGENTE = Path(__file__).resolve().parent.parent
REPO = AGENTE.parent.parent

#: (contador, etapa, o que significa). Na ordem do pipeline.
ETAPAS = (
    ("webhook_received", "1 WEBHOOK", "endpoint recebeu e validou o payload"),
    ("webhook_ignored", "1 WEBHOOK", "payload ignorado (sem mensagem utilizável)"),
    ("publish_failed", "1 WEBHOOK", "publicação no RabbitMQ FALHOU (503)"),
    ("publish_confirmed", "1 WEBHOOK", "RabbitMQ confirmou a publicação em whatsapp.inbound.v1"),
    ("messages_consumed", "2 INBOUND", "consumer tirou o evento de whatsapp.inbound.v1"),
    ("messages_duplicated", "2 INBOUND", "API já tinha esta mensagem (idempotência)"),
    ("inbound_grouped", "2 INBOUND", "mensagem persistida na API e gravada no agrupamento → ack"),
    ("group_flushed", "3 FLUSHER", "debounce venceu: grupo consolidado"),
    ("jobs_published", "3 FLUSHER", "job publicado em whatsapp.processing.v1"),
    ("messages_processed", "4 PROCESSING", "consumer tirou o job de whatsapp.processing.v1"),
    ("jobs_deferred", "4 PROCESSING", "telefone ocupado por outro job: adiado"),
    ("not_linked", "4 PROCESSING", "telefone NÃO vinculado a um usuário"),
    ("subscription_blocked", "4 PROCESSING", "usuário bloqueado pela assinatura"),
    ("llm_success", "4 PROCESSING", "LLM classificou a intenção"),
    ("llm_fallback", "4 PROCESSING", "LLM falhou; classificação por regras"),
    ("confirmation_requested", "4 PROCESSING", "faltou dado: vai perguntar ao usuário"),
    ("transactions_created", "4 PROCESSING", "lançamento criado na API"),
    ("transaction_failed", "4 PROCESSING", "API recusou o lançamento"),
    ("whatsapp_send_failed", "5 RESPOSTA", "ENVIO FALHOU"),
    ("jobs_reply_resumed", "5 RESPOSTA", "retry reenviando a resposta já calculada"),
    ("jobs_processed", "5 RESPOSTA", "resposta entregue ao messenger e job concluído"),
    ("dlq", "✖ DLQ", "mensagem foi para a DLQ"),
)
FINAIS = {"jobs_processed", "dlq", "publish_failed", "webhook_ignored"}
TELEFONE = re.compile(r"^\+\d{10,15}$")


def ler_env(arquivo: Path, chave: str) -> str:
    """Valor de ``CHAVE=`` num ``.env``, sem comentário no fim. Vazio se ausente."""
    if not arquivo.exists():
        return ""
    for linha in arquivo.read_text(encoding="utf-8").splitlines():
        if linha.startswith(f"{chave}="):
            return linha.split("=", 1)[1].split("#", 1)[0].strip()
    return ""


def argumentos() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("texto", nargs="?", default="gastei 42,90 na padaria")
    parser.add_argument("--phone", default="+5511999999999", help="E.164, ex.: +5511999999999")
    parser.add_argument("--agent", default="http://localhost:8010")
    parser.add_argument(
        "--token",
        default=os.environ.get("METRICS_TOKEN") or ler_env(AGENTE / ".env", "METRICS_TOKEN"),
        help="METRICS_TOKEN (padrão: ambiente, depois apps/ai-agent/.env)",
    )
    parser.add_argument("--timeout", type=float, default=90.0, help="segundos até desistir")
    parser.add_argument("--no-docker", action="store_true", help="não ler Redis nem Postgres")
    args = parser.parse_args()
    if not TELEFONE.match(args.phone):
        parser.error("--phone precisa estar em E.164, ex.: +5511999999999")
    return args


def contadores(client: httpx.Client, args: argparse.Namespace) -> dict[str, float]:
    headers = {"Authorization": f"Bearer {args.token}"} if args.token else {}
    resposta = client.get(f"{args.agent}/metrics.json", headers=headers)
    resposta.raise_for_status()
    return resposta.json()["counters"]


def docker_exec(*comando: str) -> str:
    resultado = subprocess.run(
        ["docker", "exec", *comando], capture_output=True, text=True, encoding="utf-8"
    )
    return resultado.stdout.strip()


def psql(sql: str) -> str:
    ambiente = REPO / "infra/docker/.env"
    usuario = ler_env(ambiente, "POSTGRES_USER") or "vellun"
    banco = ler_env(ambiente, "POSTGRES_DB") or "financial_vellun"
    return docker_exec(
        "financial-vellun-db", "psql", "-U", usuario, "-d", banco, "-P", "pager=off", "-c", sql
    )


def mostrar_agrupamento(phone: str) -> None:
    tamanho = docker_exec("financial-vellun-redis", "redis-cli", "LLEN", f"group:{phone}")
    vence = docker_exec("financial-vellun-redis", "redis-cli", "ZSCORE", "group:due", phone)
    try:
        falta = f"flush em ~{max(float(vence) - time.time(), 0):.1f}s"
    except ValueError:
        falta = "já consolidado"
    print(f"{'':15}Redis: group:{phone} com {tamanho or '?'} mensagem(ns); {falta}")


def conferir_banco(phone: str) -> None:
    print("\n── Conferência no Postgres ──")
    print(psql(
        "select m.direction, left(m.content, 90) as content, "
        "to_char(m.created_at, 'HH24:MI:SS.MS') as utc "
        "from ai_messages m join ai_conversations c on c.id = m.conversation_id "
        "join whatsapp_contacts w on w.id = c.whatsapp_contact_id "
        f"where w.phone_number = '{phone}' order by m.created_at desc limit 2;"
    ))
    print(psql(
        "select t.type, t.amount, t.description, t.transaction_date, t.source, "
        "to_char(t.created_at, 'HH24:MI:SS.MS') as utc from transactions t "
        "join whatsapp_contacts w on w.user_id = t.user_id "
        f"where w.phone_number = '{phone}' order by t.created_at desc limit 1;"
    ))


def main() -> int:
    args = argumentos()
    provider_id = f"wamid.trace.{uuid.uuid4().hex[:12]}"
    correlacao = f"trace-{uuid.uuid4().hex[:8]}"
    payload = {
        "object": "whatsapp_business_account",
        "entry": [{"changes": [{"value": {"messages": [{
            "from": args.phone.lstrip("+"),
            "id": provider_id,
            "type": "text",
            "timestamp": str(int(time.time())),
            "text": {"body": args.texto},
        }]}}]}],
    }

    print(f'Mensagem: "{args.texto}" de {args.phone}')
    print(f"providerMessageId={provider_id}  correlationId={correlacao}\n")

    with httpx.Client(timeout=10) as client:
        try:
            antes = contadores(client, args)
        except httpx.HTTPError as exc:
            print(f"✖ Não consegui ler {args.agent}/metrics.json: {exc}")
            return 1

        inicio = time.monotonic()
        resposta = client.post(
            f"{args.agent}/webhook/whatsapp", json=payload, headers={"x-correlation-id": correlacao}
        )
        decorrido = (time.monotonic() - inicio) * 1000
        print(f"[{decorrido:7.0f} ms] {'1 WEBHOOK':<13} HTTP {resposta.status_code} {resposta.text}")

        vistos: set[str] = set()
        while time.monotonic() - inicio < args.timeout:
            agora = contadores(client, args)
            for chave, etapa, descricao in ETAPAS:
                delta = agora.get(chave, 0) - antes.get(chave, 0)
                if delta <= 0 or chave in vistos:
                    continue
                vistos.add(chave)
                decorrido = (time.monotonic() - inicio) * 1000
                print(f"[{decorrido:7.0f} ms] {etapa:<13} {descricao}  ({chave} +{delta:g})")
                if chave == "inbound_grouped" and not args.no_docker:
                    mostrar_agrupamento(args.phone)
            if vistos & FINAIS:
                break
            time.sleep(0.1)
        else:
            print(f"\n✖ TIMEOUT em {args.timeout:.0f}s: o pipeline parou depois da última etapa acima")

    if not args.no_docker:
        conferir_banco(args.phone)

    return 0 if "jobs_processed" in vistos else 1


if __name__ == "__main__":
    sys.exit(main())

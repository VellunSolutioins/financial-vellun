import os
import time

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Fuso do processo em Brasília, para logs e bibliotecas que usam o horário local.
# Datas de negócio NÃO dependem disto: saem de `services/clock.py`.
#
# Só em Unix. No Windows não existe `tzset`, e definir `TZ` era pior que não
# definir: o processo filho do `uvicorn --reload` nascia com a variável e o
# runtime C lia "America/Sao_Paulo" como UTC+1 — às 20h, já era amanhã.
if hasattr(time, "tzset"):
    os.environ.setdefault("TZ", "America/Sao_Paulo")
    time.tzset()


#: Valores de ENVIRONMENT tratados como ambiente local.
LOCAL_ENVIRONMENTS = frozenset({"development", "dev", "local", "test"})

#: Tamanho mínimo dos segredos compartilhados fora do ambiente local.
MIN_SECRET_LENGTH = 16


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        # TZ (e outras chaves de ambiente consumidas fora do Settings, como o
        # próprio SO/`time.tzset()` acima) podem existir no .env sem virar campos.
        extra="ignore",
    )

    ai_agent_port: int = 8010
    # Seguro por padrão: qualquer valor fora de `LOCAL_ENVIRONMENTS` (inclusive a
    # variável ausente) é tratado como produção. Antes o padrão era
    # "development", e um deploy sem ENVIRONMENT aceitava webhook sem assinatura.
    environment: str = "production"  # "development" | "production"
    log_level: str = "INFO"  # nível dos logs da aplicação (DEBUG | INFO | WARNING | ...)
    main_api_url: str = "http://localhost:3001"
    web_url: str = "https://financial-vellun-web.vercel.app"  # base do link de regularização
    internal_api_key: str
    openai_api_key: str = ""
    whatsapp_provider_token: str = ""
    whatsapp_webhook_secret: str = ""  # App Secret (valida X-Hub-Signature-256)
    # Aceita webhook sem assinatura quando não há secret. Só tem efeito em
    # ambiente local (simulação de mensagens); fora dele o boot recusa.
    webhook_allow_unsigned: bool = False
    whatsapp_verify_token: str = ""  # token do handshake GET de verificação (Meta)
    whatsapp_provider: str = "log"  # "log" | "cloud-api" (Etapa 5)
    whatsapp_phone_number_id: str = ""
    whatsapp_api_base_url: str = "https://graph.facebook.com/v18.0"

    @property
    def is_local(self) -> bool:
        """Ambiente de desenvolvimento/teste, declarado explicitamente."""
        return self.environment.strip().lower() in LOCAL_ENVIRONMENTS

    @property
    def is_production(self) -> bool:
        """Tudo que não é declaradamente local recebe as regras de produção."""
        return not self.is_local

    # LLM
    llm_provider: str = "rules"  # "openai" | "rules"
    openai_model: str = "gpt-4o-mini"
    openai_vision_model: str = ""  # vazio → usa openai_model (gpt-4o-mini é multimodal)
    openai_transcription_model: str = "whisper-1"

    # Mídia (áudio/imagem) recebida no WhatsApp
    media_max_bytes: int = 16 * 1024 * 1024  # 16 MB (limite da Cloud API)

    # Diálogo / confirmação
    confidence_threshold: float = 0.7
    conversation_ttl_minutes: int = 30

    # Buffer / debounce de mensagens fragmentadas
    message_buffer_debounce_seconds: int = 5
    message_buffer_max_messages: int = 10
    message_buffer_max_age_seconds: int = 30
    message_buffer_backend: str = "memory"  # "memory" | "redis" (Etapa 5)

    # Redis / fila distribuída (Etapa 5)
    redis_url: str = "redis://localhost:6379/0"
    redis_lock_ttl_seconds: int = 30
    worker_poll_interval_seconds: float = 1.0
    message_buffer_max_retries: int = 3
    message_buffer_retry_base_seconds: float = 1.0

    # ── Pipeline de mensageria (broker durável) ─────────────────────────────
    # "broker" = webhook publica em fila e consumers processam (padrão);
    # "legacy" = caminho antigo (message_buffer + asyncio), mantido por uma
    # release para rollback rápido sem deploy de código.
    message_pipeline: str = "broker"  # "broker" | "legacy"
    message_broker: str = "rabbitmq"  # "rabbitmq" | "inmemory"
    rabbitmq_url: str = "amqp://guest:guest@localhost:5672/"
    rabbitmq_inbound_queue: str = "whatsapp.inbound.v1"
    rabbitmq_processing_queue: str = "whatsapp.processing.v1"
    rabbitmq_prefetch: int = 10
    inbound_consumer_concurrency: int = 5
    processing_consumer_concurrency: int = 3
    message_max_retries: int = 5
    message_retry_base_seconds: float = 1.0
    message_retry_max_seconds: float = 300.0
    # Sobe os consumers junto com a API. `false` = apenas `python -m src.worker`
    # consome (escala independente da camada HTTP).
    run_consumers_in_api: bool = True
    shutdown_drain_seconds: float = 20.0

    # Estado distribuído (agrupamento, locks e conversa)
    group_store_backend: str = "redis"  # "redis" | "memory"
    conversation_state_backend: str = "redis"  # "redis" | "memory"
    conversation_state_ttl_seconds: int = 1800
    processing_lock_ttl_seconds: int = 120
    job_dedupe_ttl_seconds: int = 86400

    # Consumer que drena as DLQs para o catalogo de falhas no Postgres
    # (`ops_failed_messages`). Desligado, as mensagens ficam na DLQ e o painel de
    # operacoes nao enxerga nada — util so para depurar o proprio pipeline.
    run_dlq_catalog_consumer: bool = True
    dlq_catalog_prefetch: int = 5
    # Janela em que um mesmo telefone recebe no máximo um aviso de falha vinda da
    # DLQ. Evita inundar o usuário num incidente. 0 desliga o aviso.
    dlq_user_notice_cooldown_seconds: int = 600

    # ── Observabilidade ────────────────────────────────────────────────────
    # Token exigido em `GET /metrics` (`Authorization: Bearer ...`). Precisa ser
    # o mesmo da API — o Alloy usa um só para os dois. Vazio libera o endpoint,
    # o que é aceitável em desenvolvimento (localhost) e recusado em produção:
    # ver `require_metrics_token` no router de métricas.
    metrics_token: str = ""
    # Porta do servidor mínimo de observabilidade do worker (`python -m
    # src.worker`), que não tem HTTP próprio. Sem ele as réplicas de consumo —
    # justamente onde o trabalho acontece — ficam invisíveis para o scrape.
    worker_metrics_port: int = 8011
    # Endereço base do `loki.source.api` do Alloy (a aplicação acrescenta
    # `/loki/api/v1/push`). Vazio desliga o envio de log. Precisa ser campo daqui,
    # e não `os.getenv`: o pydantic-settings lê o `.env` para este objeto, mas
    # NÃO o exporta para o ambiente do processo — lido por `os.getenv`, um valor
    # que só existe no `.env` simplesmente não aparece.
    loki_push_url: str = ""

    # Contexto conversacional fornecido ao LLM
    conversation_context_message_limit: int = 15
    conversation_context_max_chars: int = 4000
    message_max_chars: int = 2000

    @property
    def is_broker_pipeline(self) -> bool:
        """`True` quando o webhook publica em fila (pipeline novo)."""
        return (self.message_pipeline or "broker").strip().lower() != "legacy"

    @model_validator(mode="after")
    def _recusar_configuracao_insegura(self) -> "Settings":
        """Fora do ambiente local, configuração insegura impede o boot.

        Falhar aqui, na importação, derruba o deploy antes de receber tráfego —
        em vez de subir verde e recusar (ou pior, aceitar) cada requisição.
        """
        if self.is_local:
            return self

        problemas: list[str] = []
        if not self.whatsapp_webhook_secret.strip():
            problemas.append("WHATSAPP_WEBHOOK_SECRET vazio (assinatura do webhook)")
        if self.webhook_allow_unsigned:
            problemas.append("WEBHOOK_ALLOW_UNSIGNED=true só é permitido em ambiente local")
        if len(self.internal_api_key.strip()) < MIN_SECRET_LENGTH:
            problemas.append(
                f"INTERNAL_API_KEY com menos de {MIN_SECRET_LENGTH} caracteres"
            )
        if not self.metrics_token.strip():
            problemas.append("METRICS_TOKEN vazio (/metrics ficaria recusado)")
        if (self.whatsapp_provider or "").strip().lower() in ("", "log", "none"):
            problemas.append("WHATSAPP_PROVIDER=log não entrega respostas")

        if problemas:
            raise ValueError(
                f"Configuração insegura para ENVIRONMENT={self.environment!r}: "
                + "; ".join(problemas)
                + ". Em desenvolvimento, use ENVIRONMENT=development."
            )
        return self


settings = Settings()

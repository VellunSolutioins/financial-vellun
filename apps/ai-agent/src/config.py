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
    # Chaves internas, uma por direção (plano de segurança, S2). Vazar a que o
    # agente usa para chamar a API não permite chamar o agente, e vice-versa.
    # `INTERNAL_API_KEY` é a chave única antiga: continua aceita e é usada como
    # fallback até ser removida dos dois serviços.
    internal_api_key: str = ""
    internal_api_key_agent_to_api: str = ""
    internal_api_key_api_to_agent: str = ""
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
    def outgoing_api_key(self) -> str:
        """Chave enviada à API principal (direção agente→API)."""
        return (self.internal_api_key_agent_to_api or self.internal_api_key).strip()

    @property
    def accepted_incoming_keys(self) -> list[str]:
        """Chaves aceitas nas rotas internas do agente (direção API→agente)."""
        keys = (self.internal_api_key_api_to_agent, self.internal_api_key)
        return [key.strip() for key in keys if key.strip()]

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
    # Corpo máximo aceito no POST do webhook. Os eventos da Meta têm poucos KB;
    # o limite impede que tráfego sem assinatura ocupe memória antes da checagem.
    webhook_max_body_bytes: int = 1024 * 1024  # 1 MB

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
    rabbitmq_outbound_queue: str = "whatsapp.outbound.v1"
    rabbitmq_prefetch: int = 10
    inbound_consumer_concurrency: int = 5
    processing_consumer_concurrency: int = 3
    # Entregas simultâneas ao WhatsApp. Precisa caber no rate limit da Meta:
    # `réplicas do worker × esta concorrência` é o número de chamadas em voo.
    outbound_consumer_concurrency: int = 3
    # "queue" = a resposta é publicada em `whatsapp.outbound.v1` e entregue por
    # um consumer próprio (P3); "direct" = entrega no próprio caminho que a
    # calculou, como antes. O padrão é a fila; `direct` fica como rollback sem
    # deploy de código, no padrão da ADR-0009.
    outbound_delivery: str = "queue"  # "queue" | "direct"
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

    # Mensagens processadas (LLM, áudio, imagem) por telefone por dia. Protege
    # o custo de IA contra abuso; 0 desliga. Fica acima do uso de uma pessoa e
    # do perfil do teste de carga (que espalha por muitos telefones).
    ai_daily_message_limit: int = 200

    # Contexto conversacional fornecido ao LLM
    conversation_context_message_limit: int = 15
    conversation_context_max_chars: int = 4000
    message_max_chars: int = 2000

    @property
    def is_broker_pipeline(self) -> bool:
        """`True` quando o webhook publica em fila (pipeline novo)."""
        return (self.message_pipeline or "broker").strip().lower() != "legacy"

    @property
    def is_queued_outbound(self) -> bool:
        """`True` quando a resposta vai para `whatsapp.outbound.v1`.

        Amarrado ao pipeline de broker: no caminho legado não há fila nenhuma,
        então publicar a resposta seria enviá-la para lugar nenhum.
        """
        if not self.is_broker_pipeline:
            return False
        return (self.outbound_delivery or "queue").strip().lower() != "direct"

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
        if len(self.outgoing_api_key) < MIN_SECRET_LENGTH:
            problemas.append(
                "INTERNAL_API_KEY_AGENT_TO_API (ou INTERNAL_API_KEY) ausente ou com "
                f"menos de {MIN_SECRET_LENGTH} caracteres"
            )
        incoming = self.accepted_incoming_keys
        if not incoming or any(len(key) < MIN_SECRET_LENGTH for key in incoming):
            problemas.append(
                "INTERNAL_API_KEY_API_TO_AGENT (ou INTERNAL_API_KEY) ausente ou com "
                f"menos de {MIN_SECRET_LENGTH} caracteres"
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

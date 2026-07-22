import os
import time

from pydantic_settings import BaseSettings, SettingsConfigDict

# Fuso horário da aplicação: Brasil (America/Sao_Paulo). Garante que
# `date.today()`/`datetime.now()` (ex.: parsing de "hoje/ontem") usem o horário
# de Brasília. `tzset` só existe em sistemas Unix.
os.environ.setdefault("TZ", "America/Sao_Paulo")
if hasattr(time, "tzset"):
    time.tzset()


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
    environment: str = "development"  # "development" | "production"
    log_level: str = "INFO"  # nível dos logs da aplicação (DEBUG | INFO | WARNING | ...)
    main_api_url: str = "http://localhost:3001"
    web_url: str = "https://financial-vellun-web.vercel.app"  # base do link de regularização
    internal_api_key: str
    openai_api_key: str = ""
    whatsapp_provider_token: str = ""
    whatsapp_webhook_secret: str = ""  # App Secret (valida X-Hub-Signature-256)
    whatsapp_verify_token: str = ""  # token do handshake GET de verificação (Meta)
    whatsapp_provider: str = "log"  # "log" | "cloud-api" (Etapa 5)
    whatsapp_phone_number_id: str = ""
    whatsapp_api_base_url: str = "https://graph.facebook.com/v18.0"

    @property
    def is_production(self) -> bool:
        return self.environment.lower() in ("production", "prod")

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

    # Contexto conversacional fornecido ao LLM
    conversation_context_message_limit: int = 15
    conversation_context_max_chars: int = 4000
    message_max_chars: int = 2000


settings = Settings()

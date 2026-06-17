from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    ai_agent_port: int = 8010
    main_api_url: str = "http://localhost:3001"
    internal_api_key: str
    openai_api_key: str = ""
    whatsapp_provider_token: str = ""
    whatsapp_webhook_secret: str = ""

    # LLM
    llm_provider: str = "rules"  # "openai" | "rules"
    openai_model: str = "gpt-4o-mini"

    # Diálogo / confirmação
    confidence_threshold: float = 0.7
    conversation_ttl_minutes: int = 30


settings = Settings()

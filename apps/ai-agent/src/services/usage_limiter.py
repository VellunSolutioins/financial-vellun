"""Limite diário de processamento por telefone (plano de segurança, S2 / C12).

Cada mensagem processada pode custar uma chamada ao LLM, uma transcrição ou uma
leitura de imagem. Sem teto, um único número — vinculado ou não — gerava custo
ilimitado. O contador fica no Redis (``quota:ai:{telefone}:{dia}``), vale para o
dia local e é compartilhado entre todas as réplicas do worker.

O limite padrão fica bem acima do uso de uma pessoa e do perfil do teste de
carga, que espalha as mensagens por muitos telefones. ``0`` desliga.
"""

from __future__ import annotations

import logging

from ..config import settings
from .clock import today_local
from .distributed_state import get_state_store
from .metrics import metrics

logger = logging.getLogger(__name__)

DAILY_LIMIT_MESSAGE = (
    "Você atingiu o limite diário de mensagens processadas pelo assistente. "
    "Amanhã o limite é renovado; enquanto isso, registre seus lançamentos pelo app."
)

#: Dois dias: cobre a virada do dia em qualquer fuso sem deixar lixo no Redis.
_KEY_TTL_SECONDS = 2 * 24 * 60 * 60


class UsageLimiter:
    async def allow(self, phone: str) -> bool:
        """Conta uma mensagem do telefone e diz se ela ainda cabe no limite do dia."""
        limit = settings.ai_daily_message_limit
        if limit <= 0:
            return True
        key = f"quota:ai:{phone}:{today_local().isoformat()}"
        used = await get_state_store().incr(key, _KEY_TTL_SECONDS)
        if used > limit:
            metrics.incr("ai_daily_limit_reached")
            if used == limit + 1:
                logger.warning("Telefone atingiu o limite diário de %d mensagens", limit)
            return False
        return True


usage_limiter = UsageLimiter()

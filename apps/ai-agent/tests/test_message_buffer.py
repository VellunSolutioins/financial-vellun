"""Testes do buffer/debounce em memória (Etapa 2).

Exercitam o ``MemoryBufferBackend`` diretamente com um callback de flush falso,
evitando a chamada de rede de ``MessageBuffer.add`` (auditoria).
"""

import asyncio

from src.config import settings
from src.services.message_buffer import BufferedMessage, MemoryBufferBackend


def _make_backend(flushed: list):
    async def flush(phone: str, messages: list[BufferedMessage]) -> None:
        flushed.append((phone, [m.text for m in messages]))

    return MemoryBufferBackend(flush)


def test_max_messages_forces_immediate_flush():
    async def run():
        settings.message_buffer_max_messages = 3
        settings.message_buffer_debounce_seconds = 60
        settings.message_buffer_max_age_seconds = 600
        flushed: list = []
        backend = _make_backend(flushed)
        for i in range(3):
            await backend.add("+5511999999999", BufferedMessage(text=str(i)))
        return flushed

    flushed = asyncio.run(run())
    assert len(flushed) == 1
    assert flushed[0] == ("+5511999999999", ["0", "1", "2"])


def test_debounce_groups_messages_of_same_phone():
    async def run():
        settings.message_buffer_max_messages = 10
        settings.message_buffer_debounce_seconds = 0  # dispara no próximo tick
        settings.message_buffer_max_age_seconds = 600
        flushed: list = []
        backend = _make_backend(flushed)
        await backend.add("+5511999999999", BufferedMessage(text="gastei"))
        await backend.add("+5511999999999", BufferedMessage(text="47,50"))
        await backend.add("+5511999999999", BufferedMessage(text="no mercado"))
        await asyncio.sleep(0.05)  # deixa o timer de debounce rodar
        return flushed

    flushed = asyncio.run(run())
    assert len(flushed) == 1
    assert flushed[0] == ("+5511999999999", ["gastei", "47,50", "no mercado"])


def test_distinct_phones_are_isolated():
    async def run():
        settings.message_buffer_max_messages = 10
        settings.message_buffer_debounce_seconds = 0
        settings.message_buffer_max_age_seconds = 600
        flushed: list = []
        backend = _make_backend(flushed)
        await backend.add("+5511111111111", BufferedMessage(text="a1"))
        await backend.add("+5522222222222", BufferedMessage(text="b1"))
        await backend.add("+5511111111111", BufferedMessage(text="a2"))
        await asyncio.sleep(0.05)
        return flushed

    flushed = asyncio.run(run())
    by_phone = {phone: texts for phone, texts in flushed}
    assert by_phone["+5511111111111"] == ["a1", "a2"]
    assert by_phone["+5522222222222"] == ["b1"]

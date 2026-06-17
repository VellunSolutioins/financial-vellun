from enum import Enum

from pydantic import BaseModel, Field


class IntentType(str, Enum):
    """Intenções suportadas pelo agente (§9.2)."""

    create_transaction = "create_transaction"
    query_summary = "query_summary"
    correct_last = "correct_last"
    cancel_last = "cancel_last"
    help = "help"
    confirmation_reply = "confirmation_reply"
    unknown = "unknown"


class TransactionTypeEnum(str, Enum):
    income = "income"
    expense = "expense"
    transfer = "transfer"


class FinancialIntent(BaseModel):
    """Resultado estruturado da interpretação de uma mensagem (§9.3)."""

    intent: IntentType = IntentType.unknown
    transaction_type: TransactionTypeEnum | None = None
    amount: float | None = None
    description: str | None = None
    category_name: str | None = None
    account_name: str | None = None
    transaction_date: str | None = Field(
        default=None, description="Data do lançamento em formato ISO (YYYY-MM-DD)"
    )
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    needs_confirmation: bool = False
    confirmation_question: str | None = None

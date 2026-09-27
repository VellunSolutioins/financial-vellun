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


class AccountKindEnum(str, Enum):
    """Onde o usuário disse que o lançamento aconteceu: conta comum ou cartão."""

    account = "account"
    card = "card"


class RecurrenceTypeEnum(str, Enum):
    """Mesmos valores da API: única vez, fixo (repete) e parcelado."""

    avulso = "avulso"
    fixo = "fixo"
    parcelado = "parcelado"


class RecurrenceFrequencyEnum(str, Enum):
    """Frequências que a API aceita no fixo."""

    monthly = "monthly"
    bimonthly = "bimonthly"
    semiannual = "semiannual"
    annual = "annual"


class AmountBasisEnum(str, Enum):
    """No parcelado, se o valor informado é o total da compra ou o de cada parcela."""

    total = "total"
    installment = "installment"


class FinancialIntent(BaseModel):
    """Resultado estruturado da interpretação de uma mensagem (§9.3).

    Os campos de recorrência e de conta têm default: um estado pendente gravado
    antes deles continua sendo lido.
    """

    intent: IntentType = IntentType.unknown
    transaction_type: TransactionTypeEnum | None = None
    amount: float | None = None
    description: str | None = None
    category_name: str | None = None
    account_name: str | None = None
    account_kind: AccountKindEnum | None = Field(
        default=None, description="card quando o usuário indicar cartão de crédito"
    )
    transaction_date: str | None = Field(
        default=None, description="Data do lançamento em formato ISO (YYYY-MM-DD)"
    )
    recurrence_type: RecurrenceTypeEnum = RecurrenceTypeEnum.avulso
    recurrence_frequency: RecurrenceFrequencyEnum | None = None
    occurrences: int | None = Field(
        default=None, description="No fixo: quantas vezes o lançamento se repete"
    )
    installments: int | None = Field(default=None, description="No parcelado: número de parcelas")
    amount_basis: AmountBasisEnum | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    needs_confirmation: bool = False
    confirmation_question: str | None = None

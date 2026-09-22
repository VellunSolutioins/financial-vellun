"""Mensagem de boas-vindas a novos clientes.

É a resposta do bot quando o usuário conclui a verificação do número (ver
``phone_verification``). Antes era disparada pela API logo após o cadastro, para
um número ainda não comprovado — e, fora da janela de 24 h da Meta, um texto
livre para quem nunca escreveu ao bot nem chegava a ser entregue.
"""


def build_welcome_message(name: str | None) -> str:
    """Monta o texto de boas-vindas, personalizado pelo primeiro nome."""
    first_name = (name or "").strip().split(" ")[0] if name else ""
    greeting = f"Olá, {first_name}! 👋" if first_name else "Olá! 👋"

    return (
        f"{greeting} Seu WhatsApp foi verificado e está ligado à sua conta do "
        "Financial Vellun.\n\n"
        "Este é o seu canal para registrar lançamentos direto pelo WhatsApp. "
        "É só me mandar uma mensagem em linguagem natural, por exemplo:\n"
        "• \"gastei 50 no mercado\"\n"
        "• \"recebi 3000 de salário\"\n"
        "• \"paguei 120 de luz ontem\"\n\n"
        "Você também pode enviar um áudio ou a foto de um comprovante que eu "
        "entendo. 📸\n\n"
        "Sempre que precisar, envie \"ajuda\". Pode me contar seu primeiro "
        "lançamento agora mesmo! 🚀"
    )

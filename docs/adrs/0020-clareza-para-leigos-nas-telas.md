# 0020 — Clareza para leigos nas telas

- **Status:** Aceito
- **Data:** 2026-10-02
- **Complementa:** [0018](0018-gasto-obrigacao-liquidacao.md) e
  [0019](0019-gasto-parcelado-no-mes-da-parcela.md), que continuam valendo para o modelo
  de dados

## Contexto

As ADRs 0018 e 0019 separaram o fato (o gasto), a obrigação e a liquidação. O modelo
ficou coerente, mas as telas passaram a expor essa distinção a quem não tem formação em
finanças. Na validação com uma conta nova, os blocos de Lançamentos mostraram:

- "Receitas R$ 5.100" mesmo depois de reverter um recebimento de R$ 100. O bloco somava
  o **lançado**, e a reversão só mexia no liquidado;
- "Despesas" incluindo parcelas do cartão ainda não pagas, enquanto o pagamento da
  fatura (uma transferência) não entrava em lugar nenhum.

As notas de rodapé ("Por vencimento… Pagar não é a mesma coisa que vencer") explicavam a
regra, mas um leigo lê o número ao pé da letra.

## Decisão

**Diretriz:** cada número da tela significa o que o rótulo diz no sentido comum, e uma
ação do usuário (pagar, receber, desfazer) muda na hora o número que ele está vendo.
Termos técnicos (competência, liquidação, realizado, dívida efetiva, saldo credor) não
aparecem em rótulos. Nota explicativa é apoio, não a solução de um número ambíguo.

### Blocos de Lançamentos

`GET /transactions/summary` ganha campos de **dinheiro**, calculados sobre os mesmos
lançamentos da listagem (`buildWhere`). Os campos antigos (`income`, `expense`, `net`,
`byCategory`) ficam para os gráficos.

| Campo       | Tela             | Regra                                                                                                                |
| ----------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `received`  | Recebido         | Σ liquidações `payment` ativas de receitas em conta comum (dispensa não é dinheiro)                                  |
| `toReceive` | chip "a receber" | receitas em conta comum: valor − liquidado                                                                           |
| `paid`      | Pago             | liquidações `payment` ativas de despesas − estornos recebidos, em conta comum, + pernas `out` de pagamento de fatura |
| `toPay`     | chip "a pagar"   | despesas em conta comum: valor − liquidado                                                                           |
| `onCard`    | chip "no cartão" | despesas − estornos em cartão: viram "Pago" quando a fatura é paga                                                   |
| `leftover`  | Sobrou / Faltou  | `received − paid`                                                                                                    |

A perna de saída do pagamento de fatura tem `transaction_date` = data do pagamento, então
a fatura paga entra em "Pago" no mês em que foi paga. A compra e o pagamento nunca se
somam: a compra fica em "no cartão", e o pagamento em "Pago". Transferência entre contas
próprias não é gasto e fica fora.

### Parcelamento só para despesa

Receita parcelada é recusada na criação (app e WhatsApp) e na edição que transformaria
um parcelado em receita (`assertInstallmentIsExpense`). No formulário, "Parcelado" some
quando o tipo é Receita. No WhatsApp, o agente pergunta "Registro como receita única de
R$ X?". Receitas parceladas gravadas antes continuam funcionando, e o
`db:verify:financial-model` as conta.

### Tela Faturas

`/app/pessoal/faturas` concentra as faturas, uma por mês de vencimento, para o cartão
escolhido. O cartão inicial é, nesta ordem: o da URL, o último escolhido, o cartão ★ ou
o primeiro ativo. A tela mostra:

- o **limite do cartão** (usado, disponível e o porquê), que saiu da tela Cartões e
  deixou de ser a soma de todos os cartões;
- o **total da fatura** com a situação (aberta, fechada, vencida, paga, paga em parte,
  futura) e **Marcar como paga**;
- as compras da fatura, cuja soma bate com o total.

"Marcar como paga" é o pagamento de fatura que já existia (`CardPayment` mais duas
pernas `transfer`, ADR 0015): debita a conta, aceita valor parcial e pode ser desfeito.
Nada muda no banco. A aba de faturas do detalhe do cartão foi substituída por um link
para esta tela.

## Consequências

- O total da listagem continua batendo com as linhas visíveis, porque o pagamento da
  fatura também é uma linha da lista.
- Com o filtro "Despesa", as pernas de pagamento de fatura somem da lista e de "Pago":
  o filtro de tipo vale para os dois.
- O dashboard ainda usa a régua anterior ("Resultado do período", "Fluxo de caixa
  realizado", gráficos por competência). A revisão dele com esta diretriz fica para uma
  etapa própria.

# 0018 — Gasto, previsão, obrigação e liquidação (modelo financeiro pessoal)

- **Status:** Aceito — substituído em parte pela [0019](0019-gasto-parcelado-no-mes-da-parcela.md) quanto ao mês do gasto parcelado
- **Data:** 2026-10-02
- **Substitui em parte:** [0013](0013-recorte-por-recurso-e-base-de-data.md) (base de data),
  [0014](0014-faturas-ciclos-e-limite.md) (dívida e limite),
  [0015](0015-pagamentos-e-estornos.md) (saldo)

## Contexto

O lançamento (`transactions`) acumulava três papéis: o fato econômico (o que
se gastou), a obrigação (o que se deve) e a movimentação de caixa (o que saiu
da conta). O único status era `confirmed`/`cancelled`, e "futuro" era
decidido pela data. Na `main` (`9a11b4a`) isso produzia:

1. **Vencer liquidava.** `recalculateBalance` somava os confirmados com data
   até hoje, e o cron das 00:05 recalculava as contas quando a data chegava. O
   aluguel de amanhã saía do saldo amanhã, pago ou não; a receita prevista
   entrava sem ter sido recebida.
2. **Parcela virava gasto na data dela.** `buildSeries` gravava N despesas
   com datas mensais e o dashboard as somava como "competência": uma compra de
   R$ 1.200 em 3x aparecia como R$ 400 em três meses. Não havia entidade
   "compra".
3. **Previsão virava dívida.** Recorrência nascia `confirmed`;
   `invoicesWithAmounts` somava todas as faturas, inclusive futuras, e isso era
   dívida e limite comprometido. Uma assinatura de R$ 200 × 12 era R$ 2.400 de
   dívida no dia do cadastro.
4. **Crédito compensado só no total.** `cardPosition` somava débitos e
   créditos de todas as faturas, mas o restante de cada fatura era isolado:
   com R$ 100 de crédito numa fatura e R$ 100 de cobrança na seguinte, a dívida
   era zero e "Próximas contas" ainda mostrava R$ 100 a pagar.
   `futureInstallments` ignorava pagamento antecipado.
5. **Antes do controle = quitado.** Lançamentos anteriores a
   `invoiceTrackingStart` ficavam fora da dívida sem que ninguém dissesse que
   foram pagos. O resumo dos cartões ignorava arquivados, e cartão sem
   configuração contava como zero.
6. **Só receita e despesa.** Transferência entre contas próprias, empréstimo e
   aporte acabavam lançados como receita ou despesa (o prompt do agente
   mandava "Pix enviado é despesa").
7. **"Economia"** era receitas − despesas pela data da parcela, incluindo
   lançamentos futuros do período, e com só um cartão no filtro o saldo
   aparecia como R$ 0.
8. **Gravação em vários commits.** Saldo e fatura eram recalculados fora da
   transação do banco; pagamento de fatura não tinha trava além da chave única.

## Decisão

### Modelo (a menor evolução)

A tabela central continua; os papéis passam a ser distintos:

| Conceito                  | Onde                                           | O que é                                                                                                                                       |
| ------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Fato / obrigação          | `transactions`                                 | `event_date` (data do fato), `transaction_date` (vencimento ou previsão), `forecast`, `settled_amount` (cache do liquidado), `purchase_id`    |
| Compra parcelada          | `installment_purchases`                        | Data e total próprios; `id` = o `series_id` das parcelas (URLs `/installments/:seriesId` não mudam)                                           |
| Liquidação                | `transaction_settlements`                      | Pagamento/recebimento (`payment`, com conta) ou dispensa do restante (`write_off`, sem conta); `active`/`reversed`; origem; chave idempotente |
| Transferência própria     | `account_transfers` + 2 pernas `transfer`      | Transferência, aporte, resgate, empréstimo recebido e amortização; juros/tarifa como despesa à parte (`fee_transaction_id`)                   |
| Posição inicial do cartão | `transactions` `opening_debt`/`opening_credit` | Dívida e crédito anteriores ao controle, numa fatura anterior ao controle                                                                     |
| Empréstimo / investimento | `AccountType` `loan` / `investment`            | Conta de passivo (saldo negativo = dívida) / conta fora do "saldo em contas"                                                                  |
| Natureza do gasto         | `categories.nature`                            | `consumption`, `asset_acquisition`, `financial_cost` — mostradas à parte                                                                      |

### Regras derivadas (nada é gravado pela passagem do tempo)

- **Saldo de conta comum** = inicial + liquidações `payment` ativas (receita e
  estorno entram, despesa sai) + pernas de transferência. Sem filtro de data.
  O cron das 00:05 vira verificação de consistência: recompõe o cache, registra
  divergência e nunca cria movimentação.
- **Restante** = valor − liquidações ativas. **Estado** (calculado na leitura):
  `forecast`, `open`, `partial`, `settled`, `on_card`, `movement`, `cancelled`;
  `isOverdue` à parte (restante > 0 e vencimento < hoje). Vencido continua
  visível até ser pago, cancelado ou dispensado.
- **À vista:** com `settle`, o lançamento nasce com a liquidação no mesmo
  commit. Padrão: avulso, em conta comum, com data até hoje (compatível com
  clientes antigos). Data futura nunca nasce paga.
- **Recorrência** nasce como previsão (`forecast`); "compromisso firmado"
  (`forecast: false`) é escolha do usuário, nunca inferida. Pausar ou excluir
  não toca ocorrência já paga.
- **Cobrança efetiva no cartão:** `event_date` até hoje. A compra parcelada já
  feita é dívida inteira (o fato de todas as parcelas é a compra); assinatura e
  compra com data futura são previsão (`forecastCents`) até a data —
  **decisão do produto**: a operadora cobra a assinatura sozinha, então a
  ocorrência vira cobrança na data dela, sem gravação.
- **Créditos entre faturas** (`reconcileCard`, função pura): o excedente de uma
  fatura (pagamentos + estornos > cobranças) é crédito com origem nela, aplicado
  às faturas com restante da que vence primeiro para a última, consumindo o
  crédito mais antigo primeiro, só dentro do mesmo cartão. Cada aplicação sai na
  API (`creditsApplied`, `surplusAppliedTo`). Como é derivado de pagamentos e
  lançamentos ativos, reverter um pagamento desfaz a aplicação sozinho. Dívida,
  limite, restante por fatura, faturas futuras e "Contas a pagar" leem todos
  dessa conciliação.
- **Posição inicial:** `POST /credit-cards/:id/opening-position` grava a fatura
  anterior não paga (`opening_debt`) e o crédito (`opening_credit`) numa fatura
  que fecha no início do controle. Não é despesa. Compras anteriores ao controle
  ficam fora das faturas: importá-las depois não duplica nada.
- **Arquivados:** dívida e crédito somam todos os cartões; limite só os ativos.
  Cartão arquivado continua pagável e estornável. Cartão sem configuração
  devolve `debtKnown: false` e é contado em `incompleteCards`.

### Indicadores do dashboard pessoal

| Indicador                      | Fórmula                                                                                  | Base de data                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Saldo atual em contas          | Σ saldo das contas de caixa ativas do recorte (sem investimento, empréstimo nem cartão)  | hoje; `null` se o recorte não tem conta         |
| Gastos por data da compra      | despesas − estornos com fato no período e até hoje, sem previsão de conta ainda não paga | data do fato (compra)                           |
| Gastos previstos               | fato futuro, ou previsão de conta ainda não paga                                         | data do fato                                    |
| Receitas recebidas / a receber | Σ liquidado / Σ restante das receitas com fato no período                                | data do fato                                    |
| Resultado do período           | receitas recebidas − gastos realizados (antiga "Economia"); % das receitas recebidas     | —                                               |
| Fluxo de caixa realizado       | entradas − pagamentos − faturas pagas ± transferências com contas fora do caixa          | data do pagamento                               |
| Compromissos                   | contas vencidas, a vencer até o fim do mês, previsões, faturas (restante conciliado)     | vencimento, a partir de hoje                    |
| Cartões                        | dívida efetiva, vencido, parcelas futuras a pagar, saldo credor, previsto, incompletos   | hoje                                            |
| Saldo projetado até {data}     | saldo em contas + a receber − vencidas − a vencer − previsões − faturas até o fim do mês | vencimento; não é saldo bancário nem patrimônio |

"Gastos por data da compra" e "Compromissos por vencimento" nunca se somam. A
listagem de Lançamentos filtra por vencimento (`dateBasis=due`) ou pela data do
fato (`dateBasis=event`).

### Integridade

- Toda escrita financeira (lançamento, liquidação, estorno, pagamento de
  fatura, transferência, adiantamento, recorrência, posição inicial) grava
  registro, saldo e fatura no **mesmo commit** (`$transaction` interativa,
  `FINANCIAL_TX_OPTIONS`).
- Trava: contas `FOR UPDATE` em ordem de id (sem deadlock entre A→B e B→A);
  lançamento `FOR UPDATE` antes de liquidar; cartão `FOR UPDATE` antes de pagar.
  O banco recusa `settled_amount > amount` (`CHECK`).
- Idempotência: chave única em liquidação, transferência e lançamento manual
  (além do WhatsApp e do pagamento de fatura); corrida em `P2002` devolve o
  existente; chave de outro usuário responde 409.
- Valores em centavos inteiros no cálculo; parcelas pela regra de
  `installmentAmounts` (soma exata).

### WhatsApp

`FinancialIntent.settled` ("gastei" → pago; "vence dia 10" → em aberto; sem
indicação, a API decide pela regra do formulário). Transferência entre contas
próprias, empréstimo, aporte e resgate viram `unsupported_movement`: o agente
orienta a usar "Transferir" no app em vez de registrar como receita ou despesa.

## Migração e dados históricos

Duas migrations aditivas (`20261002120000_financial_model_enums`, separada
porque um valor novo de enum não pode ser usado na transação em que foi criado,
e `20261002120100_financial_model_tables`). O backfill é idempotente e foi
escrito para que **o saldo de cada conta comum pela regra nova seja igual ao da
regra antiga**:

1. Uma `installment_purchases` por série parcelada: data = a da parcela 1
   (antes de adiantamento); sem a parcela 1, a menor recuada (n − 1) meses;
   total = soma das parcelas antes de desconto.
2. `event_date` = data da compra nas parcelas; a própria data no resto.
3. Ocorrências futuras de recorrência viram previsão.
4. Cada receita/despesa/estorno confirmado de conta comum com data até hoje
   ganha uma liquidação do valor cheio, na data dele:
   - `legacy_recorded` — cadastrado no dia do fato ou depois, estorno ou
     parcela adiantada: o usuário registrou algo que já tinha acontecido;
   - `legacy_matured` + `needs_review` — cadastrado **antes** da data e
     "amadurecido" pelo cron: ninguém confirmou o pagamento.
5. `settled_amount` recalculado; previsão liquidada deixa de ser previsão.

**Nada é apagado nem reinterpretado em silêncio:** o saldo de todos fica igual
no deploy; o que foi inferido fica marcado e aparece em **Conferir pagamentos**
(`/app/conta/conciliacao`), onde o usuário confirma (um a um ou todos) ou
desfaz — desfazer reabre o lançamento como vencido e refaz o saldo.

Os comandos do backfill ficam entre `@backfill-start`/`@backfill-end` e só
tocam os usuários de uma tabela temporária (na migração, todos). O teste
`legacy-migration.integration.spec.ts` executa **esses mesmos comandos**, lidos
do arquivo, restritos ao usuário de teste, duas vezes, e confere saldo,
classificação e ausência de duplicação.

**Antes de liberar:** restaurar um backup (docs/retencao-e-backups.md), aplicar
as migrations nele e rodar `pnpm --filter @financial-vellun/api
db:verify:financial-model` (só leitura). Ele compara regra antiga × nova por
conta (código 1 se divergir), separa saldo gravado apenas defasado (cron que
ainda não tinha rodado no dia — o primeiro recálculo corrige), conta o que vai
para a conciliação e lista as ambiguidades abaixo. Ensaio feito sobre a cópia
do banco de desenvolvimento: 0 divergências; 2 liquidações inferidas.

**Rollback:** as migrations são aditivas; o código anterior ignora tabelas e
colunas novas. Mas o cron antigo voltaria a liquidar pela data, e lançamentos
pagos/abertos pelo modelo novo seriam somados pela regra antiga — reverter
exige recalcular os saldos (`recalculateBalance`) com o código antigo e aceitar
essa diferença.

### Ambiguidades históricas documentadas

- Série parcelada sem a parcela 1: data da compra aproximada (listada pelo
  verify).
- Pagamento inferido (`legacy_matured`): pode não ter acontecido — por isso a
  conciliação.
- Cartão com compras antes do controle e sem posição inicial: o app não sabe se
  a fatura anterior foi paga; a tela do cartão pede a posição inicial.
- Transferência antiga sem direção: continua fora do saldo (ADR 0015).
- Receita em cartão: continua listada pelo `db:audit:cards`.
- Estorno em mês diferente da compra: mantido na data do estorno (ADR 0015).
- Categoria padrão "Investimentos" (receita) significa rendimento; aporte e
  resgate passam a ser transferências.

## Premissas e limitações

- **Limite disponível é estimativa:** a operadora pode aplicar crédito,
  processar estorno ou liberar limite em outro momento.
- A ordem de aplicação de créditos (vencimento mais antigo primeiro) é
  convenção do app; o total é o mesmo em qualquer ordem.
- Cobrança de cartão com data do fato até hoje é tratada como efetiva — inclusive
  compra cadastrada com data futura, quando a data chega.
- Receita só é "realizada" quando recebida; gasto é realizado pela data do fato.
  A assimetria é intencional (prudência).
- Não é contabilidade: "Gastos" não é despesa contábil. Aquisição de bens e
  juros são classificados à parte; não há depreciação, balanço nem
  apropriação de serviço antecipado.
- Parcela de cartão: o "compromisso restante" de uma fatura paga em parte é
  rateado entre as cobranças dela, pro rata.
- O PJ só foi adaptado para continuar correto (a pagar/receber = em aberto,
  fluxo de caixa = movimentações); nenhuma regra empresarial nova.
- Fora do escopo: importação de extratos, juros de empréstimo calculados,
  desfazer adiantamento, transferência pelo WhatsApp.

## Alternativas consideradas

- **Status `pending`/`paid` no lançamento.** Rejeitada: não representa
  pagamento parcial, múltiplo, de outra conta nem reversão com histórico —
  foi justamente o `pending` removido em 2026-09-23.
- **Tabela de obrigações separada dos lançamentos.** Rejeitada por ora: exigiria
  migrar todas as linhas e reescrever listagens, faturas e o agente; o
  lançamento já é a obrigação, faltava a liquidação.
- **Gravar a aplicação de créditos entre faturas.** Rejeitada: teria de ser
  desfeita a cada reversão, estorno ou troca de fechamento. Derivada, é sempre
  consistente com pagamentos e lançamentos ativos.
- **Liquidar o legado pela data, sem marca.** Rejeitada: presumiria pagamento só
  porque a data passou. **Deixar o legado em aberto:** rejeitada — mudaria o
  saldo de quase todos no deploy.

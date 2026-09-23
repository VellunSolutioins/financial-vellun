# Melhorias selecionadas

Base: `main` em `a2aed0c`. Referência visual e funcional: `feature/melhorias` em `f2dc491`.

## Escopo

Dashboard pessoal, lançamentos, recorrências, metas de gastos, cartões, agenda/lembretes,
anotações, contas e categorias. O menu recolhível, ícones e estilo visual vêm da branch
de referência. As atualizações de segurança, autenticação, WhatsApp, infraestrutura e
performance da main permanecem na base. Análise Financeira, Caixinhas, membros e
alterações comerciais dos planos não fazem parte desta extração.

## Recorrências

Lançamentos e Recorrências usam `TransactionsView`, `TransactionForm` e `/transactions`.
A segunda tela consulta `recurrenceType=fixo`, com os mesmos filtros de mês, status,
tipo e categoria. Não existe cadastro de regra separado nem gerador de regras em cron.

Um lançamento fixo cria uma série mensal pelo período informado (2 a 120 meses).
O valor informado é o de cada ocorrência. A primeira respeita o status escolhido;
as futuras ficam pendentes. Datas no fim do mês são ajustadas para o último dia válido.
A edição e exclusão afetam a ocorrência selecionada, refletindo nas duas telas.
Parcelamentos mantêm o comportamento de dividir o valor total, com os centavos
restantes na última parcela. Não entram no filtro de lançamentos fixos.

## Agenda e lembretes

Uma única tela apresenta o calendário, os compromissos e as contas a pagar. Nela é
possível cadastrar, editar e excluir ambos, e marcar/desmarcar lembretes como pagos.
O endereço antigo `/app/pessoal/lembretes` redireciona para a agenda.
Compromissos e lembretes conservam seus modelos próprios de armazenamento.
A marcação de um lembrete como pago não cria uma transação financeira; preserva o
comportamento da referência. Também não foi acrescentado envio de notificações.

## Cartões

Conservam o controle de limite e saldo da referência. O comprometimento da renda
consulta receitas fixas do mês em `transactions`, excluindo canceladas. O saldo
devedor é apresentado como fatura; fechamento e liquidação por ciclo ainda não fazem
parte desta implementação.

## Banco e execução local

A migração `20260923190000_selected_improvements` acrescenta os campos de série em
`transactions` e as tabelas de metas, cartões, agenda, lembretes e anotações. Os dados
anteriores da main permanecem; lançamentos existentes recebem o tipo `avulso`.
Ela é destinada à main, não ao banco experimental da feature/melhorias.

Nesta máquina, a pasta `.worktrees/melhorias-selecionadas` tem dependências e arquivos
locais de ambiente preparados. O banco `financial_vellun_melhorias_selecionadas` é
separado do banco original e recebeu as migrações e o seed de desenvolvimento.
A API usa a porta 3002 e o frontend a 3003. A cobrança está desativada **somente no
arquivo local ignorado pelo Git**, para permitir avaliar as telas com o usuário demo.
Redis e serviços externos não são necessários para essa avaliação das telas.

Em dois terminais na raiz dessa pasta:

```powershell
pnpm api:dev
```

```powershell
pnpm --filter @financial-vellun/web exec next dev -p 3003
```

Abra `http://localhost:3003`. Em outra instalação, configure `.env` conforme os
exemplos da main, execute `pnpm install`, `pnpm prisma:generate` e aplique as migrações
no banco destinado à nova versão.

## Verificação

```powershell
pnpm typecheck
pnpm --filter @financial-vellun/api build
pnpm --filter @financial-vellun/web build
pnpm --filter @financial-vellun/api test --runInBand
```

O teste `selected-features.integration.spec.ts` usa PostgreSQL real e só roda quando
`SELECTED_FEATURES_TEST_DATABASE_URL` aponta para um banco local cujo nome termina
em `_validation`, com as migrações aplicadas. Cria usuários próprios de teste e os
remove ao terminar. Verifica séries, saldo, edição/exclusão, isolamento entre usuários,
cartões, metas, compromissos, lembretes e notas.

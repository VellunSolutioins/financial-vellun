# Retenção de dados e backups

Escrito para quem opera o Financial Vellun. Responde três perguntas: o que o
sistema guarda, por quanto tempo, e como recuperar se algo for perdido.

Origem: etapa S4 do [plano de segurança](../plan/plano-implementacao-seguranca.md).

## O que é guardado e por quanto tempo

| Dado                             | Onde                                  | Retenção                              | Como é aplicada                                                                              |
| -------------------------------- | ------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| Texto das mensagens do WhatsApp  | `ai_messages.content`                 | 90 dias (`AI_CONTENT_RETENTION_DAYS`) | Job diário às 4h substitui o texto por `[conteúdo removido por retenção]`; a linha permanece |
| Texto que originou uma extração  | `ai_extracted_transactions.raw_input` | 90 dias (a mesma variável)            | Mesmo job                                                                                    |
| Falhas do pipeline               | `ops_failed_messages`                 | `retention_until` da própria linha    | Job diário às 3h apaga a linha                                                               |
| Trilha de mudanças de identidade | `user_security_events`                | Sem expurgo                           | Append-only: só sai junto com a conta                                                        |
| Trilha de operações              | `ops_audit_log`                       | Sem expurgo                           | Append-only                                                                                  |
| Lançamentos, contas, categorias  | tabelas do produto                    | Enquanto a conta existir              | Exclusão de conta (LGPD)                                                                     |

**Por que o texto some e a linha fica:** o lançamento criado já vive em
`transactions`, e o contexto que o agente usa é de dias. Manter a linha preserva
a idempotência por `providerMessageId`, o encadeamento das conversas e as
métricas de volume.

`AI_CONTENT_RETENTION_DAYS=0` desliga o expurgo. O job roda em lotes de 500
linhas, de madrugada, para não competir com o tráfego do dia.

## O que sai do sistema

- **Provedor de IA (OpenAI):** recebe o texto da mensagem e o contexto montado em
  `message_processor._build_context` (categorias, contas, data e as últimas
  mensagens). Não recebe e-mail, CPF/CNPJ, endereço nem identificadores da conta.
- **Meta (WhatsApp):** recebe o número e o texto da resposta enviada.
- **Grafana Cloud (logs):** recebe log estruturado. Telefone sai com hash em
  produção (`safe_phone`); conteúdo de mensagem não é registrado.

## Backups

O Postgres é gerenciado pelo Railway, que faz os backups da instância. O que
precisa estar decidido e verificado:

1. **Frequência e janela de retenção** dos backups, no painel do Railway.
2. **Onde ficam as credenciais** para restaurar (cofre da equipe, não no repositório).
3. **Quem pode restaurar** e por qual procedimento.

### Restauração — procedimento

```bash
# 1. Criar uma instância nova a partir do backup (nunca restaurar por cima da
#    instância em uso: a restauração é destrutiva).
# 2. Apontar uma cópia da API para ela e conferir, sem tráfego real:
pnpm --filter @financial-vellun/api exec prisma migrate status   # migrations aplicadas
# 3. Conferências mínimas na instância restaurada:
#    - contagem de linhas em users, transactions, ai_messages
#    - a última transação criada bate com a data do backup
#    - login de um usuário de teste funciona
# 4. Só então redirecionar a aplicação.
```

**Pendente:** executar um teste de restauração de ponta a ponta e anotar aqui a
data, o tempo que levou e o que foi conferido. Sem esse ensaio, o backup é uma
suposição.

## Exclusão de conta (LGPD)

O plano está em [plan/account-deletion-lgpd-plan.md](../plan/account-deletion-lgpd-plan.md).
Dois pontos que a S4 fixou e que a implementação precisa respeitar:

- `user_security_events` sai junto com a conta (cascata a partir de `users`); o
  trigger recusa alteração e `TRUNCATE`, mas não a exclusão em cascata.
- O conteúdo das mensagens antigas já terá sido expurgado pela retenção, então a
  exclusão lida com um volume menor de dado pessoal.

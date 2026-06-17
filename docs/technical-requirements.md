# Financial Vellun - Requisitos Tecnicos

## 1. Visao Geral

O Financial Vellun sera uma aplicacao de controle financeiro para usuarios pessoa fisica e pessoa juridica. A plataforma tera uma interface web, uma API principal para regras de negocio e uma API em Python responsavel pelo agente de IA que interpretara mensagens recebidas via WhatsApp para criar lancamentos financeiros automaticamente.

O projeto sera organizado como um monorepo, permitindo evoluir os aplicativos de forma independente, mas compartilhando contratos, convencoes e infraestrutura.

## 2. Objetivos Do Produto

- Permitir cadastro e autenticacao de usuarios.
- Suportar perfis de pessoa fisica e pessoa juridica.
- Direcionar o usuario autenticado para a area adequada conforme seu perfil.
- Exibir dashboards financeiros com indicadores relevantes.
- Permitir criacao, edicao, listagem, filtro e categorizacao de lancamentos.
- Permitir lancamentos manuais pelo app web.
- Permitir lancamentos por conversa via WhatsApp usando agente de IA.
- Manter rastreabilidade da origem dos lancamentos, principalmente os criados por IA.
- Estruturar a base para recursos futuros como recorrencia, anexos, importacao bancaria, metas, orcamentos e relatorios.

## 3. Arquitetura Do Monorepo

Estrutura proposta:

```txt
financial-vellun/
  apps/
    web/
    api/
    ai-agent/
  packages/
    shared/
    config/
  infra/
    docker/
    database/
  docs/
    technical-requirements.md
```

### 3.1 `apps/web`

Aplicacao frontend responsavel por:

- landing page publica;
- login e cadastro;
- area autenticada;
- dashboards;
- listagem e gestao de lancamentos;
- configuracoes de usuario, contas e categorias;
- fluxo visual separado para pessoa fisica e pessoa juridica.

Stack recomendada:

- Next.js;
- TypeScript;
- Tailwind CSS;
- shadcn/ui ou biblioteca equivalente;
- React Hook Form;
- Zod para validacao client-side;
- cliente HTTP tipado para comunicacao com `apps/api`.

### 3.2 `apps/api`

API principal responsavel pelas regras de negocio e persistencia.

Responsabilidades:

- autenticacao e autorizacao;
- gerenciamento de usuarios;
- gerenciamento de perfis pessoa fisica e juridica;
- gerenciamento de contas financeiras;
- gerenciamento de categorias;
- CRUD de lancamentos;
- calculo de indicadores para dashboard;
- aplicacao de regras de negocio;
- exposicao de endpoints consumidos pelo frontend;
- recebimento de comandos seguros vindos do agente de IA.

Stack recomendada:

- Node.js;
- TypeScript;
- NestJS;
- PostgreSQL;
- Prisma ORM;
- JWT ou sessao segura baseada em cookies;
- Zod ou class-validator para validacao;
- Swagger/OpenAPI para documentacao da API.

### 3.3 `apps/ai-agent`

API Python responsavel pelo recebimento de mensagens de WhatsApp e processamento por agente de IA.

Responsabilidades:

- receber webhooks do provedor de WhatsApp;
- identificar usuario pelo numero de telefone;
- manter contexto de conversa quando necessario;
- interpretar mensagens financeiras em linguagem natural;
- extrair tipo, valor, descricao, categoria, data e conta;
- calcular nivel de confianca da interpretacao;
- pedir confirmacao quando a mensagem for ambigua;
- chamar `apps/api` para criar lancamentos confirmados;
- registrar historico e auditoria das interpretacoes.

Stack recomendada:

- Python;
- FastAPI;
- Pydantic;
- LangGraph ou LangChain;
- OpenAI API ou outro provedor de LLM;
- cliente HTTP para comunicacao com `apps/api`.

## 4. Perfis De Usuario

O usuario deve possuir um tipo principal de perfil:

- `individual`: pessoa fisica;
- `business`: pessoa juridica.

Campos base do usuario:

```txt
User
  id
  name
  email
  password_hash
  profile_type
  created_at
  updated_at
```

Pessoa fisica:

```txt
IndividualProfile
  id
  user_id
  cpf
  birth_date
  created_at
  updated_at
```

Pessoa juridica:

```txt
BusinessProfile
  id
  user_id
  company_name
  trade_name
  cnpj
  created_at
  updated_at
```

## 5. Modulos Funcionais

### 5.1 Landing Page

Requisitos:

- pagina publica em `/`;
- apresentar proposta do produto;
- permitir acesso a login;
- permitir criacao de conta;
- indicar que a aplicacao suporta controle financeiro pessoal e empresarial;
- destacar o lancamento via WhatsApp como diferencial.

### 5.2 Autenticacao

Requisitos:

- login por email e senha;
- senha armazenada com hash seguro;
- protecao de rotas autenticadas;
- refresh de sessao ou token;
- logout;
- validacao de usuario ativo;
- redirecionamento pos-login conforme `profile_type`.

Rotas sugeridas:

```txt
POST /auth/register
POST /auth/login
POST /auth/logout
POST /auth/refresh
GET  /auth/me
```

### 5.3 Area Pessoa Fisica

Rotas web sugeridas:

```txt
/app/pessoal/dashboard
/app/pessoal/lancamentos
/app/pessoal/categorias
/app/pessoal/contas
/app/pessoal/configuracoes
```

Dashboard inicial:

- saldo atual;
- total de receitas no periodo;
- total de despesas no periodo;
- resultado do mes;
- distribuicao por categoria;
- ultimos lancamentos;
- comparativo mensal simples.

### 5.4 Area Pessoa Juridica

Rotas web sugeridas:

```txt
/app/empresa/dashboard
/app/empresa/lancamentos
/app/empresa/contas-a-pagar
/app/empresa/contas-a-receber
/app/empresa/clientes
/app/empresa/fornecedores
/app/empresa/categorias
/app/empresa/configuracoes
```

Funcionalidades iniciais:

- fluxo de caixa;
- receitas e despesas por periodo;
- contas a pagar;
- contas a receber;
- fornecedores;
- clientes;
- categorias por centro de custo.

Para o MVP, pessoa juridica pode iniciar com o mesmo motor de lancamentos da pessoa fisica, mantendo campos que permitam evolucao empresarial.

## 6. Lancamentos Financeiros

O lancamento financeiro sera a entidade central da aplicacao.

Campos sugeridos:

```txt
Transaction
  id
  user_id
  account_id
  category_id
  type
  amount
  description
  transaction_date
  status
  source
  raw_input
  created_at
  updated_at
```

Tipos:

- `income`: receita;
- `expense`: despesa;
- `transfer`: transferencia.

Status:

- `confirmed`;
- `pending`;
- `cancelled`.

Origem:

- `manual`;
- `whatsapp`;
- `ai`;
- `import`;
- `recurring`.

Filtros obrigatorios:

- periodo;
- tipo;
- categoria;
- conta;
- status;
- origem;
- texto livre por descricao.

Acoes:

- criar lancamento;
- editar lancamento;
- excluir ou cancelar lancamento;
- visualizar detalhes;
- filtrar;
- ordenar;
- paginar.

## 7. Categorias

Categorias devem permitir organizacao dos lancamentos.

Campos sugeridos:

```txt
Category
  id
  user_id
  name
  type
  color
  icon
  is_default
  created_at
  updated_at
```

Categorias iniciais para pessoa fisica:

- Alimentacao;
- Mercado;
- Moradia;
- Transporte;
- Saude;
- Educacao;
- Lazer;
- Salario;
- Investimentos;
- Outros.

Categorias iniciais para pessoa juridica:

- Vendas;
- Servicos;
- Fornecedores;
- Impostos;
- Folha de pagamento;
- Aluguel;
- Marketing;
- Software;
- Transporte;
- Outros.

## 8. Contas Financeiras

Contas representam onde o dinheiro entra ou sai.

Campos sugeridos:

```txt
Account
  id
  user_id
  name
  type
  initial_balance
  current_balance
  currency
  is_active
  created_at
  updated_at
```

Tipos:

- conta corrente;
- poupanca;
- dinheiro;
- cartao de credito;
- carteira digital;
- investimento;
- outros.

## 9. Agente De IA Via WhatsApp

### 9.1 Fluxo Principal

1. Usuario envia mensagem no WhatsApp.
2. Provedor de WhatsApp envia webhook para `apps/ai-agent`.
3. `apps/ai-agent` identifica o contato pelo numero.
4. O agente interpreta a mensagem.
5. O agente classifica intencao e extrai dados financeiros.
6. Se a confianca for suficiente, cria o lancamento via `apps/api`.
7. Se houver ambiguidade, responde solicitando confirmacao.
8. O resultado fica registrado para auditoria.

Exemplo:

```txt
Entrada:
"gastei 100 no mercado"

Interpretacao:
type: expense
amount: 100
description: mercado
category: Mercado
date: hoje
confidence: high
```

### 9.2 Intencoes Do Agente

Intencoes iniciais:

- criar despesa;
- criar receita;
- consultar resumo;
- corrigir ultimo lancamento;
- cancelar ultimo lancamento;
- pedir ajuda;
- responder confirmacao.

### 9.3 Dados Extraidos

Schema esperado:

```txt
FinancialIntent
  intent
  transaction_type
  amount
  description
  category_name
  account_name
  transaction_date
  confidence
  needs_confirmation
  confirmation_question
```

### 9.4 Regras De Confirmacao

O agente deve pedir confirmacao quando:

- nao identificar valor;
- nao identificar se e receita ou despesa;
- encontrar mais de uma categoria provavel;
- a mensagem indicar parcelamento;
- houver data ambigua;
- o contato nao estiver vinculado a um usuario;
- o valor parecer incoerente;
- a confianca estiver abaixo do limite minimo.

Exemplo:

```txt
Usuario:
"paguei 300"

Resposta:
"Esse pagamento foi de qual categoria? Ex: mercado, aluguel, transporte ou outros."
```

### 9.5 Auditoria De IA

Toda operacao feita pelo agente deve manter:

- mensagem original;
- numero de telefone;
- usuario identificado;
- interpretacao estruturada;
- confianca;
- resposta enviada ao usuario;
- lancamento criado, se houver;
- data e hora do processamento.

## 10. Comunicacao Entre APIs

O `apps/ai-agent` nao deve acessar diretamente o banco principal. Ele deve chamar endpoints internos do `apps/api`.

Endpoints internos sugeridos:

```txt
GET  /internal/whatsapp/contacts/:phone
POST /internal/transactions/from-ai
POST /internal/ai-events
```

Esses endpoints devem ser protegidos por chave interna, token de servico ou autenticacao entre servicos.

## 11. Banco De Dados

Banco recomendado:

- PostgreSQL.

Tabelas iniciais:

```txt
users
individual_profiles
business_profiles
accounts
categories
transactions
whatsapp_contacts
ai_conversations
ai_messages
ai_extracted_transactions
```

### 11.1 WhatsApp Contacts

```txt
WhatsappContact
  id
  user_id
  phone_number
  provider
  is_verified
  created_at
  updated_at
```

### 11.2 Conversas De IA

```txt
AiConversation
  id
  user_id
  whatsapp_contact_id
  status
  last_message_at
  created_at
  updated_at
```

```txt
AiMessage
  id
  conversation_id
  direction
  content
  metadata
  created_at
```

### 11.3 Extracoes De IA

```txt
AiExtractedTransaction
  id
  user_id
  transaction_id
  source_message_id
  raw_input
  extracted_payload
  confidence
  status
  created_at
  updated_at
```

## 12. Requisitos Nao Funcionais

### 12.1 Seguranca

- senhas com hash seguro;
- protecao contra acesso cruzado entre usuarios;
- validacao server-side em todos os endpoints;
- protecao dos endpoints internos;
- logs sem dados sensiveis desnecessarios;
- sanitizacao de entradas;
- rate limit nos endpoints publicos e webhooks;
- configuracao por variaveis de ambiente.

### 12.2 Privacidade

- mensagens do WhatsApp devem ser tratadas como dado sensivel;
- guardar apenas o necessario para auditoria e melhoria do produto;
- permitir exclusao ou anonimização futura de dados do usuario;
- separar dados por usuario de forma rigorosa.

### 12.3 Observabilidade

- logs estruturados;
- rastreamento de erros;
- metricas basicas por servico;
- registro de falhas no processamento de mensagens;
- status dos webhooks recebidos.

### 12.4 Performance

- paginacao obrigatoria em listagens;
- indices por `user_id`, `transaction_date`, `type`, `category_id` e `account_id`;
- processamento do webhook deve ser rapido;
- tarefas demoradas do agente podem ser colocadas em fila futuramente.

### 12.5 Escalabilidade

- apps independentes;
- API Python isolada para evoluir o agente;
- possibilidade futura de filas;
- possibilidade futura de workers;
- contratos claros entre `apps/api` e `apps/ai-agent`.

## 13. Variaveis De Ambiente

Variaveis iniciais para `apps/api`:

```txt
DATABASE_URL
JWT_SECRET
JWT_REFRESH_SECRET
API_PORT
INTERNAL_API_KEY
```

Variaveis iniciais para `apps/web`:

```txt
NEXT_PUBLIC_API_URL
```

Variaveis iniciais para `apps/ai-agent`:

```txt
AI_AGENT_PORT
MAIN_API_URL
INTERNAL_API_KEY
OPENAI_API_KEY
WHATSAPP_PROVIDER_TOKEN
WHATSAPP_WEBHOOK_SECRET
```

## 14. MVP Proposto

O primeiro MVP deve conter:

- monorepo configurado;
- app web com landing page, login e area autenticada;
- app API com autenticacao, usuarios, categorias, contas e lancamentos;
- app Python com endpoint de webhook simulado;
- dashboard inicial para pessoa fisica;
- tela de lancamentos com tabela e filtros;
- criacao manual de lancamentos;
- criacao de lancamento via mensagem simulada no agente;
- auditoria basica de mensagens processadas por IA.

Escopo fora do MVP:

- integracao real com banco/Open Finance;
- importacao OFX;
- anexos;
- relatorios avancados;
- recorrencia completa;
- contas a pagar/receber completas para pessoa juridica;
- multiplos usuarios por empresa;
- permissoes avancadas por equipe.

## 15. Roadmap Tecnico Sugerido

### Fase 1 - Fundacao

- criar estrutura do monorepo;
- configurar package manager;
- configurar lint, formatacao e TypeScript;
- criar Docker Compose com PostgreSQL;
- criar API principal;
- criar modelo inicial no banco;
- criar app web base;
- criar API Python base.

### Fase 2 - Produto Pessoal

- cadastro/login;
- area autenticada;
- dashboard pessoa fisica;
- CRUD de categorias;
- CRUD de contas;
- CRUD de lancamentos;
- filtros e paginacao.

### Fase 3 - IA E WhatsApp

- endpoint de webhook no `ai-agent`;
- interpretador de mensagens;
- schema de extracao estruturada;
- chamadas internas para `apps/api`;
- confirmacao de mensagens ambiguas;
- auditoria de conversas.

### Fase 4 - Pessoa Juridica

- dashboard empresarial inicial;
- contas a pagar e receber;
- clientes e fornecedores;
- categorias empresariais;
- fluxo de caixa.

### Fase 5 - Evolucao

- lancamentos recorrentes;
- metas e orcamentos;
- relatorios;
- importacao de extratos;
- notificacoes;
- multiempresa;
- permissoes por equipe.

## 16. Decisoes Em Aberto

- Provedor de WhatsApp: Z-API, Twilio, Meta Cloud API ou outro.
- Modelo de autenticacao: JWT puro ou cookies HTTP-only.
- Provedor de IA: OpenAI inicialmente ou arquitetura multi-provider.
- Modelo de cobranca do produto.
- Suporte a multiplas empresas por usuario.
- Necessidade de plano gratuito.
- Nivel de detalhe inicial para pessoa juridica.
- Estrategia de deploy.

## 17. Criterios De Aceite Do MVP

- Usuario consegue criar conta e fazer login.
- Usuario pessoa fisica e pessoa juridica sao direcionados para areas distintas.
- Usuario pessoa fisica consegue criar, editar, listar e filtrar lancamentos.
- Dashboard exibe indicadores coerentes com os lancamentos.
- Agente Python recebe uma mensagem simulada de WhatsApp.
- Mensagem como "gastei 100 no mercado" gera um lancamento de despesa.
- Lancamento criado pela IA fica identificado com origem apropriada.
- Mensagens ambiguas nao criam lancamento sem confirmacao.
- Dados de um usuario nao ficam acessiveis para outro usuario.

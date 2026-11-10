# 0023 — Feature flags globais controladas pelo /ops

- **Status:** Aceito
- **Data:** 2026-11-09

## Contexto

Todo item do menu do app ficava sempre disponível. Precisamos desligar funcionalidades
não essenciais para todos os usuários (um bug em produção, uma funcionalidade em
validação) sem deploy, e garantir que a funcionalidade desligada não abra **nem pela URL**.

Os itens essenciais (Dashboard, Lançamentos, Recorrências, Parcelamentos, Faturas, Metas
de gastos, Cartões, Contas, Categorias) não têm flag e ficam sempre disponíveis. As
primeiras flags são `agenda` (Agenda e Lembretes) e `notes` (Anotações).

## Decisão

- **O código define quais flags existem; o banco guarda o estado.**
  - O tipo `FeatureKey` fica em `packages/shared/src/features.ts`.
  - O catálogo (`FEATURE_CATALOG`, em `apps/api/src/feature-flags/feature-flags.catalog.ts`)
    tem rótulo, descrição e `defaultEnabled` de cada flag.
  - A tabela `feature_flags` guarda o estado. Sem linha, vale o default do catálogo; linha
    com chave fora do catálogo é ignorada. Uma flag nova não precisa de migration.
- **A proteção real é a API.**
  - `@RequireFeature(key)` + `FeatureEnabledGuard` nos controllers da funcionalidade.
  - Desligada, a API responde 403 com `code: 'FEATURE_DISABLED'`.
  - `GET /features` entrega o estado ao app (sem guard de assinatura).
- **No web, o bloqueio é no cliente.** O `middleware.ts` não enxerga a sessão (cookie
  HttpOnly no domínio da API), então o layout do app:
  - esconde os itens de menu com flag até confirmar que estão ligados;
  - não renderiza a rota de uma funcionalidade desligada e redireciona ao dashboard;
  - o `api-client` trata `FEATURE_DISABLED` voltando ao dashboard (página já aberta
    quando a flag foi desligada).
- **Só `ops_admin` altera**, em `/ops/funcionalidades`, com justificativa obrigatória. A
  alteração e a linha em `ops_audit_log` (antes/depois) vão na mesma transação.
  `viewer` e `operator` veem a tela em modo leitura.
- **Sem cache.** A leitura é por chave primária numa tabela minúscula; com várias réplicas
  da API, um cache local deixaria réplicas respondendo diferente depois de uma mudança.
- **Desligar não apaga dados.** Eles voltam quando a flag é religada.

## Como adicionar uma funcionalidade com flag

1. Acrescentar a chave em `FeatureKey` (`packages/shared/src/features.ts`).
2. Acrescentar a entrada em `FEATURE_CATALOG` (o TypeScript obriga).
3. Marcar os controllers com `@RequireFeature('<chave>')` e incluir `FeatureEnabledGuard`
   no `@UseGuards`; o módulo importa `FeatureFlagsModule`.
4. Mapear as rotas do web em `FEATURE_ROUTES` (`apps/web/src/lib/features.ts`; o
   TypeScript obriga).
5. Pôr `feature: '<chave>'` no item do menu em `apps/web/src/app/app/layout.tsx`.
6. Se o agente de IA ou algum job usar a funcionalidade, decidir ali o que fazer com a
   flag desligada (hoje nenhum usa Agenda nem Anotações).

## Consequências

- Uma flag desligada vale para todos na próxima requisição, sem deploy.
- O web depende de `GET /features` para montar o menu: se a chamada falhar, as
  funcionalidades com flag ficam ocultas (estado seguro) até recarregar.
- Flags por plano ou por usuário ficam fora; `Plan.features` continua sendo outra coisa.
  `BILLING_ENFORCEMENT_ENABLED` é candidata natural a migrar para esta tabela no futuro.

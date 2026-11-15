# Análise de segurança — Financial Vellun

Data: 21/09/2026. Escopo: revisão estática direcionada da API NestJS, aplicação Next.js, agente Python, autenticação, WhatsApp, pagamentos, operações e infraestrutura versionada. Não é um pentest nem uma certificação de segurança. Não foram acessados os serviços de produção nem os valores dos arquivos `.env`. Gravidades refletem impacto e condições necessárias; exposição externa e controles da plataforma precisam ser verificados no deploy.

## Avaliação

Existem boas proteções implementadas, mas o ciclo de identidade do WhatsApp e a revogação de sessões precisam ser corrigidos prioritariamente. Não foi demonstrada execução remota de código nem invasão de produção. O relatório separa defeitos presentes no código de riscos condicionais de configuração.

## 1. Alta — telefone declarado é tratado como verificado

Evidência: `apps/api/src/auth/auth.service.ts:21` e `:93`; `apps/api/src/users/users.service.ts:142`; `apps/api/src/internal/internal.service.ts:71`.

Cadastro e edição de perfil vinculam o telefone informado ao usuário com `isVerified: true`, sem desafio de posse. A API resolve a identidade do WhatsApp por esse vínculo. A busca por `isVerified` no agente encontrou o campo descrito no contrato, sem uma verificação de autorização correspondente.

Um usuário pode reservar um número ainda não vinculado que pertence a terceiro. Se o terceiro conversar com o bot, sua atividade será associada à conta indevida, observadas as demais regras de acesso/assinatura. Também pode haver bloqueio do cadastro legítimo daquele número. Isso não permite, por si só, sobrescrever um número já vinculado: existe uma checagem de conflito.

Correção: desafio de posse de uso único, expirável e limitado por tentativas; manter vínculo pendente até confirmação; exigir vínculo verificado na resolução de identidade. Fazer a reivindicação de maneira atômica: a checagem prévia seguida de `upsert` também permite disputa concorrente por um telefone.

Validação sugerida: telefone pendente não acessa dados; terceiro não consegue reivindicar número sem prova; duas reivindicações concorrentes têm apenas um vencedor.

## 2. Alta — troca de telefone não revoga o número antigo

Evidência: `apps/api/src/users/users.service.ts:92` e `:142`.

O fluxo cria/atualiza o novo `whatsappContact`, mas não desvincula os contatos antigos do usuário. A resolução de identidade continua aceitando esses registros. Se o número antigo for perdido, transferido ou reciclado, seu novo possuidor poderá continuar operando no escopo financeiro associado, conforme as funcionalidades do bot e as regras de assinatura.

Correção: trocar o vínculo numa transação, somente após verificar o novo número; revogar o anterior e invalidar conversas/confirmações pendentes. Se múltiplos números forem uma funcionalidade intencional, listá-los explicitamente na conta com revogação individual e verificação independente.

Validação sugerida: depois da troca, o número antigo não resolve mais a identidade nem conclui uma confirmação pendente.

## 3. Alta — logout e troca de senha não invalidam tokens

Evidência: `apps/api/src/auth/auth.controller.ts:42`; `apps/api/src/auth/auth.service.ts:131`; `apps/api/src/auth/strategies/jwt-refresh.strategy.ts`; `apps/api/src/users/users.service.ts:79`.

Logout apenas apaga cookies no navegador. Troca de senha apenas grava outro hash. O refresh token dura sete dias e sua validação verifica assinatura/expiração e existência do usuário, sem sessão revogável ou detecção de reutilização. Renovar emite outro token sem invalidar o anterior.

Um refresh token roubado continua utilizável após logout/troca de senha e pode sustentar acesso além dos sete dias originais por renovações sucessivas. O roubo inicial do token é uma precondição; não foi identificado aqui um mecanismo direto de extração desses cookies.

Correção: sessões persistidas, refresh token armazenado como hash, rotação de uso único e revogação da família em caso de reutilização. Invalidar sessões na troca de senha e oferecer encerramento de todos os dispositivos. Usar versão de sessão ou equivalente para revogação dos tokens de acesso.

`members.service.ts:123` também troca senha ao remover membro, sem invalidar tokens. A leitura atual de `householdOwnerId` retira o acesso à família, mas a sessão da conta removida continua viva; não confundir esses dois efeitos.

Referência: [OWASP — gerenciamento de sessões](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

## 4. Alta, condicional — webhook aceita mensagens sem assinatura por configuração padrão

Evidência: `apps/ai-agent/src/config.py:28`; `apps/ai-agent/src/routers/webhook.py:62`.

`ENVIRONMENT` assume `development`. Sem segredo de webhook nesse modo, `_verify_signature` retorna verdadeiro. Se uma instância acessível externamente subir sem ambas as configurações corretas, terceiros poderão enviar eventos inventados, inclusive com números de outras pessoas. Configurar apenas `NODE_ENV=production` não altera essa variável Python.

Em `ENVIRONMENT=production`, o código rejeita requisições quando falta o segredo: essa proteção existe. O risco é o modo inseguro ser implícito e não haver bloqueio na inicialização.

Correção: exigir assinatura por padrão; liberar simulação somente por opção explícita restrita a testes/desenvolvimento local; validar configuração antes de iniciar. Verificar também URL interna, segredos vazios/fracos e separação de chaves.

## 5. Média — previews e localhost são confiáveis para CORS e CSRF

Evidência: `apps/api/src/common/http-origin.util.ts:1`; `apps/api/src/common/guards/csrf.guard.ts`.

A lista contém localhost e uma expressão que aceita previews de branches Vercel, independentemente do ambiente. O guard CSRF aceita essas origens mesmo sem token CSRF válido. Cookies de produção usam `SameSite=None`.

Se um preview autorizado pela expressão servir código malicioso ou comprometido e um usuário autenticado o visitar, esse código poderá tentar chamadas autenticadas e leitura das respostas, sujeito às políticas de cookies do navegador. Não significa que qualquer domínio da Vercel seja aceito.

Correção: allowlist exata e exclusiva do ambiente; previews devem usar API/dados de homologação. Testar rejeição de previews e localhost em produção. Também revisar isenção de origem nas rotas de criação de sessão para prevenir login CSRF.

## 6. Alta se exposta — infraestrutura local publica serviços em todas as interfaces

Evidência: `infra/docker/docker-compose.yml:10`, `:36`, `:56` e `:59`.

Postgres, Redis, broker, painel RabbitMQ e métricas têm portas publicadas sem endereço de loopback. Redis não recebe autenticação na configuração versionada; RabbitMQ tem fallback `guest/guest`. O alcance real depende do firewall, Docker e rede. Não foi verificado acesso externo nem se este compose é usado em produção.

Correção: em desenvolvimento, publicar em `127.0.0.1`; em produção, rede privada e nenhuma porta de dados/gestão pública. Configurar credenciais distintas, ACLs, TLS quando aplicável e privilégio mínimo. Não considerar senha padrão uma proteção adequada, nem presumir o comportamento de acesso remoto de `guest` sem verificar a imagem/configuração efetiva.

## 7. Média — limites de tamanho chegam depois da alocação

Evidência: `apps/ai-agent/src/routers/webhook.py:135`; `apps/ai-agent/src/services/whatsapp_media.py:54`.

O webhook carrega o corpo completo antes de verificar assinatura; não foi localizado limite de corpo nesse caminho da aplicação. O download de mídia materializa todo o arquivo antes de comparar seu tamanho com `media_max_bytes`. O primeiro caminho pode consumir memória com tráfego não autenticado se o proxy não limitar o corpo. O segundo depende das mídias retornadas pelo provedor e da concorrência.

Correção: limitar bytes recebidos no proxy e na aplicação; baixar mídia por streaming com interrupção no limite; limitar itens por lote, concorrência e consumo por usuário. Manter limites específicos para webhooks sem impedir entregas legítimas. Validar destinos/redirects de download como defesa adicional; a URL atual vem do provedor, portanto não foi demonstrado SSRF controlado diretamente pelo usuário.

## 8. Média — sessões administrativas não possuem prazo absoluto

Evidência: `apps/api/src/ops/auth/guards/ops-auth.guard.ts`; `apps/api/src/ops/auth/ops-session.service.ts`; `apps/api/src/ops/auth/ops-auth.service.ts`.

O painel relê operador ativo e permissões no banco a cada requisição, o que é positivo. Porém, renova continuamente o JWT perto da expiração. Não existe prazo absoluto de sessão nesse fluxo, e pertencimento à organização GitHub é consultado no login. Remover alguém da organização, sem desativá-lo no banco local, pode deixar sua sessão existente renovável.

Correção: sessão revogável, prazo absoluto, sincronização/revalidação da elegibilidade no GitHub e procedimento de desligamento que desative o operador local. Exigir MFA na identidade administrativa e reautenticação para ações sensíveis, verificando a configuração efetiva do provedor.

## 9. Média — dependências sem manutenção/reprodutibilidade suficiente

Evidência: `pnpm-lock.yaml:185` resolve Next.js 14.2.35; `apps/ai-agent/requirements.txt` usa somente limites mínimos, sem lock com hashes.

Next.js 14 consta como não suportado na [política oficial consultada](https://nextjs.org/support-policy). Recomenda-se migrar para uma linha suportada e aplicar o patch de segurança vigente. Isso não comprova que toda vulnerabilidade publicada afete as rotas utilizadas aqui. A versão 14.2.35 aparece como correção no [aviso de dezembro de 2025](https://nextjs.org/blog/security-update-2025-12-11), portanto não seria correto atribuir automaticamente ao projeto as falhas corrigidas naquele aviso.

Correção: atualização planejada do frontend; lock Python reprodutível, preferencialmente com hashes; auditoria automatizada das dependências diretas/transitivas e imagens no CI. Não foi executada uma auditoria completa de CVEs nesta revisão.

## Melhorias adicionais

- **Mudança de identidade:** `users.service.ts:92` permite alterar e-mail/telefone sem reautenticação. Exigir senha/MFA recente, verificar o novo destino e notificar o anterior. Normalizar e-mail de maneira consistente.
- **Privacidade:** `LogMessenger` registra telefone e texto completos (`apps/ai-agent/src/services/messenger/log_messenger.py:12`), e o provider padrão é `log`. Impedir esse provider em produção e aplicar sanitização também às mensagens livres, não só aos campos estruturados.
- **Retenção:** há limpeza explícita para falhas operacionais; não foi localizada política equivalente para `AiMessage.content` e `AiExtractedTransaction.rawInput`. Definir finalidade, retenção, descarte, acesso e proteção de backups. Validar os dados efetivamente enviados ao provedor de IA.
- **Frontend:** `apps/web/next.config.js` não define CSP ou outros headers de proteção. Helmet na API não protege os documentos HTML do frontend. Verificar headers entregues pela hospedagem e implantar CSP inicialmente em modo de relatório.
- **Container:** `Dockerfile.ai-agent` não define usuário não privilegiado. Executar com usuário dedicado, limitar recursos e capacidades e usar filesystem somente leitura onde possível.
- **API interna:** uma chave compartilhada dá acesso amplo aos escopos internos. Isolar rede, limitar credenciais por serviço e planejar rotação; não depender do nome `/internal` para isolamento.
- **Rate limiting:** a API usa limites por IP; validar identificação do cliente atrás do proxy e compartilhamento do contador entre réplicas. Adicionar proteção por conta e limites de custo do processamento de IA.
- **Convites:** o aceite verifica status antes da transação e não revalida capacidade/plano no momento do consumo. Consumir o convite com condição atômica e revalidar elegibilidade; testar aceite concorrente com revogação.
- **Segredos:** os `.env` reais não aparecem na listagem de arquivos rastreados consultada. Isso não é varredura do histórico Git nem prova de ausência de segredos em outros arquivos. Implantar scanner de segredos no histórico/CI e rotação em caso de exposição confirmada.

## Controles positivos observados

Validação executada: `pnpm.cmd --filter @financial-vellun/api exec jest --runInBand auth.service.spec.ts csrf.guard.spec.ts internal-api-key.guard.spec.ts ops-auth.guard.spec.ts asaas-payment.provider.spec.ts`. Resultado: 6 suítes e 60 testes aprovados (o filtro também selecionou `ops-auth.service.spec.ts`). São testes existentes; não reproduzem todos os cenários identificados neste relatório.

- Hash de senha bcrypt com custo 12; cookies de sessão HttpOnly e Secure quando o ambiente Node está em produção.
- ValidationPipe global com whitelist e rejeição de campos inesperados; Helmet e Swagger condicionado ao ambiente na API.
- Guards de autenticação e validação de propriedade em transações, recorrências e cartões amostrados; criação por IA também valida conta e categoria contra o usuário.
- Assinatura HMAC do WhatsApp quando configurada; token de webhook Asaas com comparação em tempo constante e rejeição quando ausente.
- Idempotência e persistência de eventos de pagamento, além de controles de duplicação no pipeline.
- Painel de operações com identidade GitHub, ativação explícita, papéis lidos do banco e separação de token/chave do produto.
- Testes existentes para autenticação, CSRF, chave interna, autorização operacional e provider de pagamento. Testes unitários não substituem validação de ponta a ponta com dois usuários e cookies reais.

## Ordem recomendada

1. Corrigir verificação/revogação de telefone e sessões; verificar imediatamente ambiente/segredo do webhook e exposição das portas.
2. Restringir origens de produção, limitar corpos/downloads e corrigir o ciclo de sessão administrativa.
3. Migrar Next.js, fixar dependências Python e automatizar verificações de segurança.
4. Completar retenção, headers, isolamento de serviços, auditoria de mudanças de identidade e testes de restauração de backups.

Critérios de aceite prioritários: token anterior rejeitado após revogação; refresh reutilizado detectado; número antigo sem acesso; número não verificado sem acesso; preview rejeitado em produção; webhook inválido recusado; payload excessivo interrompido; IDs de outro usuário negados em leitura, escrita e relações.

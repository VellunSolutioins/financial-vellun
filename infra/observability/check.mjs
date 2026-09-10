#!/usr/bin/env node
/**
 * Valida os arquivos de observabilidade. `pnpm obs:check`.
 *
 * Roda três coisas, e as três importam por motivos diferentes:
 *
 * 1. `alloy validate` — pega argumento inexistente e referência a componente que
 *    não existe. Uma config inválida deixa o Alloy sem subir, e aí a coleta
 *    inteira para;
 * 2. `promtool check rules` — pega PromQL malformado. Uma regra inválida é
 *    recusada pelo ruler, e o alerta simplesmente não existe;
 * 3. `promtool test rules` — pega a regra **válida que não faz o que deveria**.
 *    É o único dos três que responde "esse alerta dispara mesmo?".
 *
 * Em Node, e não em shell, porque o repositório é usado no Windows e um `.sh`
 * exigiria Git Bash — enquanto `node` já é pré-requisito.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = resolve(aqui, '..', '..');

// Pinadas junto com o compose de observabilidade: validar com uma versão e rodar
// com outra é como não validar.
const ALLOY = 'grafana/alloy:v1.19.2';
const PROM = 'prom/prometheus:latest';

let falhas = 0;

function docker(args, titulo) {
  process.stdout.write(`\n▶ ${titulo}\n`);
  const resultado = spawnSync('docker', args, { stdio: 'inherit', shell: false });

  if (resultado.error) {
    process.stdout.write(`  ✗ não foi possível executar o docker: ${resultado.error.message}\n`);
    falhas += 1;
    return;
  }
  if (resultado.status !== 0) {
    process.stdout.write(`  ✗ falhou (exit ${resultado.status})\n`);
    falhas += 1;
    return;
  }
  process.stdout.write('  ✓ ok\n');
}

const montaAlloy = `${resolve(raiz, 'infra/observability/alloy')}:/cfg`;
const montaAlertas = `${resolve(raiz, 'infra/observability/alerts')}:/r`;

for (const arquivo of ['config.alloy', 'config.alloy.local']) {
  docker(
    ['run', '--rm', '-v', montaAlloy, ALLOY, 'validate', `/cfg/${arquivo}`],
    `alloy validate ${arquivo}`,
  );
}

docker(
  [
    'run',
    '--rm',
    '--entrypoint',
    'promtool',
    '-v',
    montaAlertas,
    PROM,
    'check',
    'rules',
    '/r/whatsapp-pipeline.yaml',
    '/r/plataforma.yaml',
  ],
  'promtool check rules',
);

docker(
  [
    'run',
    '--rm',
    '--entrypoint',
    'promtool',
    '-v',
    montaAlertas,
    PROM,
    'test',
    'rules',
    '/r/tests/whatsapp-pipeline.test.yaml',
    '/r/tests/plataforma.test.yaml',
  ],
  'promtool test rules',
);

if (falhas > 0) {
  process.stdout.write(`\n${falhas} verificação(ões) falhou(aram).\n`);
  process.exit(1);
}
process.stdout.write('\nTodas as verificações de observabilidade passaram.\n');

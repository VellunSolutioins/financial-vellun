#!/usr/bin/env node
/**
 * Valida os arquivos de observabilidade. `pnpm obs:check`.
 *
 * Roda quatro coisas, e as quatro importam por motivos diferentes:
 *
 * 1. `alloy validate` — pega argumento inexistente e referência a componente que
 *    não existe. Uma config inválida deixa o Alloy sem subir, e aí a coleta
 *    inteira para;
 * 2. `promtool check rules` — pega PromQL malformado. Uma regra inválida é
 *    recusada pelo ruler, e o alerta simplesmente não existe;
 * 3. `promtool test rules` — pega a regra **válida que não faz o que deveria**.
 *    É o único que responde "esse alerta dispara mesmo?";
 * 4. o PromQL **dos dashboards**, pelo mesmo `promtool`. Um painel com consulta
 *    inválida não quebra nada na importação: ele só aparece com um triângulo
 *    vermelho, e quem olha acha que é falta de dado. Foi assim que um `\.` (escape
 *    inválido em string PromQL) passou despercebido no painel de DLQ.
 *
 * Em Node, e não em shell, porque o repositório é usado no Windows e um `.sh`
 * exigiria Git Bash — enquanto `node` já é pré-requisito.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

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
    return false;
  }
  if (resultado.status !== 0) {
    process.stdout.write(`  ✗ falhou (exit ${resultado.status})\n`);
    falhas += 1;
    return false;
  }
  process.stdout.write('  ✓ ok\n');
  return true;
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

checarDashboards();

/**
 * Valida o PromQL de todos os painéis.
 *
 * O `promtool` não lê dashboard, então as consultas viram regras de gravação
 * (`record`) num arquivo temporário — o parser é o mesmo, e é o que importa. As
 * variáveis do Grafana são trocadas por valores concretos antes, do mesmo jeito
 * que o Grafana faz antes de mandar a consulta ao Mimir.
 */
function checarDashboards() {
  const pastaDashboards = resolve(raiz, 'infra/observability/dashboards');
  const consultas = [];

  for (const arquivo of readdirSync(pastaDashboards).filter((nome) => nome.endsWith('.json'))) {
    const dashboard = JSON.parse(readFileSync(join(pastaDashboards, arquivo), 'utf8'));
    // Painéis podem estar aninhados dentro de linhas (`type: row`).
    const paineis = (dashboard.panels ?? []).flatMap((p) => [p, ...(p.panels ?? [])]);

    for (const painel of paineis) {
      for (const alvo of painel.targets ?? []) {
        if (!alvo.expr) continue;
        consultas.push({ arquivo, painel: painel.title, ref: alvo.refId, expr: alvo.expr });
      }
    }
  }

  const concreta = (expr) =>
    expr
      .replace(/\$\{?env\}?/g, 'development')
      .replace(/\$__(rate_interval|interval|range)/g, '5m');

  // YAML entre aspas simples: barra invertida é literal, e só `'` precisa dobrar.
  const linhas = ['groups:', '  - name: dashboards', '    rules:'];
  consultas.forEach((c, i) => {
    linhas.push(`      - record: dashboard_consulta_${i + 1}`);
    linhas.push(`        expr: '${concreta(c.expr).replace(/'/g, "''")}'`);
  });

  const pastaTemp = mkdtempSync(join(tmpdir(), 'vellun-dashboards-'));
  try {
    writeFileSync(join(pastaTemp, 'dashboards.yaml'), `${linhas.join('\n')}\n`, 'utf8');

    const ok = docker(
      [
        'run',
        '--rm',
        '--entrypoint',
        'promtool',
        '-v',
        `${pastaTemp}:/d`,
        PROM,
        'check',
        'rules',
        '/d/dashboards.yaml',
      ],
      `promtool nas ${consultas.length} consultas dos dashboards`,
    );

    if (!ok) {
      // O erro do promtool cita `dashboard_consulta_N`, que não diz nada a quem
      // abre o dashboard. Esta tabela traduz o N para arquivo e painel.
      process.stdout.write('  Onde está cada consulta citada acima:\n');
      consultas.forEach((c, i) => {
        process.stdout.write(
          `    dashboard_consulta_${i + 1}: ${c.arquivo} › ${c.painel} [${c.ref}]\n`,
        );
      });
    }
  } finally {
    rmSync(pastaTemp, { recursive: true, force: true });
  }
}

if (falhas > 0) {
  process.stdout.write(`\n${falhas} verificação(ões) falhou(aram).\n`);
  process.exit(1);
}
process.stdout.write('\nTodas as verificações de observabilidade passaram.\n');

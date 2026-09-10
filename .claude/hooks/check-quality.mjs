#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Todo caminho e todo comando aqui é resolvido contra a raiz derivada deste arquivo, nunca contra o
// diretório de trabalho de quem invoca: o cwd do processo que dispara o gancho é livre, e resolver
// contra ele mede outro diretório — sem erro, respondendo que falta `npm ci` onde nada falta.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function run(cmd) {
  try {
    return {
      ok: true,
      out: execSync(cmd, {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (err) {
    return { ok: false, out: (err.stdout || '') + (err.stderr || '') };
  }
}

function block(reason) {
  console.log(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

// A pergunta é "há trabalho fora de origin/main?", e não "há arquivo por commitar?": a árvore fica
// limpa no instante em que o trabalho vira commit, e um gate preso ao status para de verificar
// justamente aí — inclusive num merge que resolveu conflito pela metade. Quando não há como
// responder (sem origin/main, sem git), verifica-se assim mesmo.
function hasWorkToVerify() {
  if (run('git status --porcelain').out.trim() !== '') {
    return true;
  }
  const baseline = run('git rev-parse --verify --quiet origin/main');
  if (!baseline.ok || baseline.out.trim() === '') {
    return true;
  }
  const ahead = run('git log --oneline origin/main..HEAD');
  return !ahead.ok || ahead.out.trim() !== '';
}

if (!hasWorkToVerify()) {
  process.exit(0);
}

const pkgPath = path.join(projectRoot, 'package.json');
if (!existsSync(pkgPath)) {
  process.exit(0);
}

// Sem dependência instalada, lint, tipos e testes falham em bloco por módulo ausente: a parede de
// erro resultante não distingue defeito no código de ambiente incompleto, e passaria por
// verificação feita.
if (!existsSync(path.join(projectRoot, 'node_modules'))) {
  block(
    'Dependências não instaladas. Rode `npm ci` — sem elas lint, tipos e testes falham por módulo ausente e a checagem não prova nada sobre o código.',
  );
}

// O Prisma Client não é conferido aqui: os comandos abaixo o geram antes de rodar, pelo mesmo
// `codegen` que garante o pacote de contrato. Uma checagem de existência bloquearia pedindo um
// passo manual, e ainda deixaria passar o caso que mais dói — cliente presente porém velho, que
// ela não distingue de um cliente atual.

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const scripts = pkg.scripts || {};
const failures = [];

if (scripts.lint) {
  const lint = run('npm run lint --silent');
  if (!lint.ok) failures.push(`lint:\n${lint.out.trim()}`);
}

// Na mesma ordem do CI, e antes dos testes porque é o passo mais rápido dos três. O build não
// substitui esta checagem: tsconfig.build.json exclui **/*spec.ts, então erro de tipo em arquivo de
// teste só apareceria no CI.
if (scripts.typecheck) {
  const typecheck = run('npm run typecheck --silent');
  if (!typecheck.ok) failures.push(`typecheck:\n${typecheck.out.trim()}`);
}

if (scripts['test:cov']) {
  const coverage = run('npm run test:cov --silent');
  if (!coverage.ok) failures.push(`test:cov:\n${coverage.out.trim()}`);
} else if (scripts.test) {
  const test = run('npm test --silent');
  if (!test.ok) failures.push(`test:\n${test.out.trim()}`);
}

if (failures.length > 0) {
  block(
    'Lint, tipos, teste e/ou cobertura falharam. Corrija antes de finalizar:\n\n' +
      failures.join('\n\n'),
  );
}

process.exit(0);

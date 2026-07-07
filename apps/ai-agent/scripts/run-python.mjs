// Cross-platform launcher para o Python da venv do agente de IA.
// Resolve `.venv\Scripts\python.exe` (Windows) ou `.venv/bin/python` (Linux/macOS)
// e repassa todos os argumentos. Uso: node scripts/run-python.mjs -m uvicorn ...
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const agentRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const python = isWindows
  ? join(agentRoot, '.venv', 'Scripts', 'python.exe')
  : join(agentRoot, '.venv', 'bin', 'python');

if (!existsSync(python)) {
  console.error(
    `\n[run-python] venv não encontrada em ${python}.\n` +
      `Crie e instale as dependências antes de rodar o agente:\n` +
      `  cd apps/ai-agent\n` +
      `  python -m venv .venv\n` +
      (isWindows
        ? `  .venv\\Scripts\\python.exe -m pip install -e .\n`
        : `  .venv/bin/python -m pip install -e .\n`),
  );
  process.exit(1);
}

const child = spawn(python, process.argv.slice(2), {
  cwd: agentRoot,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error(`[run-python] falha ao iniciar o Python: ${err.message}`);
  process.exit(1);
});

#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const input = JSON.parse(readFileSync(0, 'utf8'));
if (input.tool_name !== 'Bash') process.exit(0);

const cmd = (input.tool_input || {}).command || '';
if (!cmd) process.exit(0);

const rulesPath = path.join(__dirname, 'dangerous-commands.json');
const rules = JSON.parse(readFileSync(rulesPath, 'utf8')).map((r) => ({
  name: r.name,
  re: new RegExp(r.pattern, r.flags || ''),
}));

const hit = rules.find((r) => r.re.test(cmd));

if (hit) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Comando bloqueado: padrão perigoso "${hit.name}" detectado em "${cmd}". Se a intenção é legítima, execute manualmente fora do Claude Code e explique o resultado.`,
      },
    }),
  );
}

process.exit(0);

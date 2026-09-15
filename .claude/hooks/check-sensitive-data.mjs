#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const input = JSON.parse(readFileSync(0, 'utf8'));
const toolName = input.tool_name;
const toolInput = input.tool_input || {};

let content = '';
if (toolName === 'Write') {
  content = toolInput.content || '';
} else if (toolName === 'Edit') {
  content = toolInput.new_string || '';
} else if (toolName === 'Bash') {
  content = toolInput.command || '';
} else {
  process.exit(0);
}

const filePath = toolInput.file_path || '';

if (
  /node_modules\/|package-lock\.json$|pnpm-lock\.yaml$|\.lock$|\.(png|jpg|jpeg|gif|svg|ico)$/.test(
    filePath,
  )
) {
  process.exit(0);
}

function isValidCPF(raw) {
  const s = raw.replace(/\D/g, '');
  if (s.length !== 11 || /^(\d)\1{10}$/.test(s)) return false;
  const nums = s.split('').map(Number);
  const checkDigit = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += nums[i] * (len + 1 - i);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return checkDigit(9) === nums[9] && checkDigit(10) === nums[10];
}

const cpfCandidates = content.match(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g) || [];
const realCpfFound = cpfCandidates.some(isValidCPF);

function isValidCardPAN(raw) {
  const s = raw.replace(/[\s-]/g, '');

  if (!/^(4\d{12}(\d{3})?|5[1-5]\d{14}|3[47]\d{13}|6(?:011|5\d{2})\d{12})$/.test(s)) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = Number(s[i]);
    if (shouldDouble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

const cardCandidates = content.match(/\b(?:\d[ -]?){13,19}\b/g) || [];
const realCardFound = cardCandidates.some(isValidCardPAN);

const patternsPath = path.join(__dirname, 'secret-patterns.json');
const secretPatterns = JSON.parse(readFileSync(patternsPath, 'utf8')).map((p) => ({
  name: p.name,
  re: new RegExp(p.pattern, p.flags || ''),
}));

const secretHit = secretPatterns.find((p) => p.re.test(content));

if (realCpfFound || realCardFound || secretHit) {
  const motivo = realCpfFound
    ? 'CPF completo e válido encontrado sem máscara no conteúdo gravado. Use o padrão ***.***.NNN-NN; em teste, gere o CPF via helper — nunca como literal no código.'
    : realCardFound
      ? 'Número de cartão de pagamento válido encontrado no conteúdo gravado. Dados de pagamento nunca podem aparecer em código, log ou fixture — use um número de teste do próprio sandbox do provedor de pagamento, nunca um PAN real ou plausível hardcoded.'
      : `Padrão de segredo detectado (${secretHit.name}). Segredos nunca podem ser hardcoded — devem vir de variável de ambiente ou cofre de segredos.`;

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: motivo,
      },
    }),
  );
}

process.exit(0);

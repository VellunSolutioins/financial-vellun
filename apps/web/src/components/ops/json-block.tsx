import { formatJson } from './ops-format';

/**
 * Bloco de JSON do diagnóstico.
 *
 * Rola nos dois eixos em vez de quebrar linha: um payload de webhook quebrado em
 * palavras deixa de ser JSON legível. Em telas estreitas isso significa rolar —
 * o que é preferível a uma parede de texto sem estrutura.
 */
export function JsonBlock({ value, label }: { value: unknown; label?: string }) {
  return (
    <div className="space-y-1.5">
      {label && <p className="text-xs font-medium text-muted-foreground">{label}</p>}
      <pre className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed">
        {formatJson(value)}
      </pre>
    </div>
  );
}

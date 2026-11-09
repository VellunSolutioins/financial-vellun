import { CircleAlert } from 'lucide-react';

/** Erro geral do formulário (o que não pertence a um campo específico). */
export function FormAlert({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/5 p-3.5 text-sm text-danger"
    >
      <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      {messages.length === 1 ? (
        <p>{messages[0]}</p>
      ) : (
        <ul className="list-disc space-y-1 pl-4">
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

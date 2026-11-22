'use client';
import { useEffect, useState } from 'react';

const formatter = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Sao_Paulo',
});

/**
 * Hora de Brasília, atualizada a cada 15 s. No servidor sai "--:--": a hora
 * real só entra no navegador, para o HTML não divergir na hidratação.
 */
export function LiveClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <time dateTime={now?.toISOString()} className="tabular-nums" suppressHydrationWarning>
      {now ? formatter.format(now) : '--:--'}
    </time>
  );
}

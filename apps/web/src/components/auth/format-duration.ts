function plural(value: number, singular: string, pluralForm: string): string {
  return `${value} ${value === 1 ? singular : pluralForm}`;
}

/** `60` → "1 hora"; `90` → "1 hora e 30 minutos"; `30` → "30 minutos". */
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return plural(rest, 'minuto', 'minutos');
  if (rest === 0) return plural(hours, 'hora', 'horas');
  return `${plural(hours, 'hora', 'horas')} e ${plural(rest, 'minuto', 'minutos')}`;
}

/** `45` → "0:45"; `75` → "1:15". */
export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

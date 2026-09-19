'use client';

interface Props {
  score: number;
  color: string;
}

/** Medidor em arco (semicírculo) — SVG puro, sem lib externa. */
export function ScoreGauge({ score, color }: Props) {
  const radius = 80;
  const circumference = Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, score));
  const offset = circumference * (1 - clamped / 100);
  const arcPath = 'M 20 100 A 80 80 0 1 1 180 100';

  return (
    <div className="relative mx-auto w-full max-w-[220px]">
      <svg viewBox="0 0 200 110" className="w-full">
        <path
          d={arcPath}
          fill="none"
          stroke="currentColor"
          strokeWidth="16"
          strokeLinecap="round"
          className="text-muted"
        />
        <path
          d={arcPath}
          fill="none"
          stroke={color}
          strokeWidth="16"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.5s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pt-4">
        <span className="text-3xl font-bold">{Math.round(clamped)}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">de 100</span>
      </div>
    </div>
  );
}

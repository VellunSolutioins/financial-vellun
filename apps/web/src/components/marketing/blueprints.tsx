import { cn } from '@/lib/utils';

/**
 * Ilustrações em traço de desenho técnico para os recursos da landing: linhas
 * de construção tracejadas, marcas de corte, cotas e um marcador na cor da
 * marca no ponto principal. SVG puro, que segue as cores do tema (`currentColor`).
 */

function Frame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 240 180"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn('h-auto w-full text-ink-muted', className)}
    >
      {/* Marcas de corte nos cantos. */}
      <g stroke="currentColor" strokeWidth="1" opacity="0.5">
        <path d="M8 18V8h10M222 8h10v10M232 162v10h-10M18 172H8v-10" />
      </g>
      {children}
    </svg>
  );
}

/** Alvo na cor da marca: círculo, mira e ponto. */
function Marker({ x, y }: { x: number; y: number }) {
  return (
    <g className="text-primary" stroke="currentColor" strokeWidth="1.5">
      <circle cx={x} cy={y} r="7" />
      <path d={`M${x - 12} ${y}h5M${x + 7} ${y}h5M${x} ${y - 12}v5M${x} ${y + 7}v5`} />
      <circle cx={x} cy={y} r="1.8" fill="currentColor" />
    </g>
  );
}

/** Cota vertical com traços nas pontas e texto pequeno ao lado. */
function DimensionV({ x, y1, y2, label }: { x: number; y1: number; y2: number; label: string }) {
  const mid = (y1 + y2) / 2;
  return (
    <g stroke="currentColor" strokeWidth="1" opacity="0.7">
      <path d={`M${x} ${y1}V${y2}M${x - 4} ${y1}h8M${x - 4} ${y2}h8`} />
      <text
        x={x - 6}
        y={mid}
        transform={`rotate(-90 ${x - 6} ${mid})`}
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontSize="8"
        fontFamily="var(--font-mono), monospace"
      >
        {label}
      </text>
    </g>
  );
}

/** fig. 02 — celular com mensagem de texto, áudio e foto. */
export function MessageBlueprint({ className }: { className?: string }) {
  return (
    <Frame className={className}>
      {/* Construção. */}
      <g stroke="currentColor" strokeWidth="0.75" strokeDasharray="3 4" opacity="0.45">
        <path d="M20 90h200M120 12v156" />
        <circle cx="120" cy="90" r="70" />
      </g>
      {/* Aparelho. */}
      <g stroke="currentColor" strokeWidth="1.5">
        <rect x="86" y="20" width="68" height="140" rx="12" />
        <rect x="92" y="32" width="56" height="116" rx="4" />
        <path d="M112 26h16" />
        {/* Mensagem enviada e resposta. */}
        <rect x="112" y="46" width="32" height="14" rx="5" />
        <rect x="96" y="68" width="40" height="22" rx="5" />
        <path d="M101 75h26M101 82h18" />
        {/* Áudio: onda. */}
        <rect x="108" y="100" width="36" height="14" rx="5" />
        <path d="M114 107h2M119 103v8M123 105v4M127 102v10M131 104v6M135 106v2" />
      </g>
      {/* Foto do comprovante, saindo do aparelho. */}
      <g stroke="currentColor" strokeWidth="1.5">
        <rect x="166" y="104" width="44" height="54" rx="3" transform="rotate(8 188 131)" />
        <path
          d="M174 118h26M174 126h20M174 134h24M174 146h12"
          transform="rotate(8 188 131)"
          opacity="0.8"
        />
      </g>
      <DimensionV x={66} y1={20} y2={160} label="whatsapp" />
      <Marker x={128} y={53} />
    </Frame>
  );
}

/** Etiqueta de categoria (contorno, furo e nome), já posicionada. */
function CategoryTag({
  label,
  transform,
  opacity,
}: {
  label: string;
  transform: string;
  opacity?: number;
}) {
  return (
    <g transform={transform} opacity={opacity}>
      {/* Largura para o nome mais longo ("assinaturas") em mono 11 px. */}
      <path d="M0 0h84l18 18-18 18H0a6 6 0 0 1-6-6V6a6 6 0 0 1 6-6Z" />
      <circle cx="86" cy="18" r="4" />
      <text
        x="6"
        y="22"
        fill="currentColor"
        stroke="none"
        fontSize="11"
        fontFamily="var(--font-mono), monospace"
      >
        {label}
      </text>
    </g>
  );
}

/** fig. 03 — etiquetas de categoria em leque. */
export function TagsBlueprint({ className }: { className?: string }) {
  return (
    <Frame className={className}>
      <g stroke="currentColor" strokeWidth="0.75" strokeDasharray="3 4" opacity="0.45">
        <path d="M20 150h200M48 20v140" />
        <path d="M48 150L200 40" />
      </g>
      <g stroke="currentColor" strokeWidth="1.5">
        <CategoryTag label="moradia" transform="translate(70 34) rotate(-14)" opacity={0.55} />
        <CategoryTag label="assinaturas" transform="translate(66 70) rotate(-4)" opacity={0.8} />
        <CategoryTag label="mercado" transform="translate(62 108) rotate(6)" />
      </g>
      {/* Ângulo do leque. */}
      <g stroke="currentColor" strokeWidth="1" opacity="0.7">
        <path d="M48 150a38 38 0 0 1 22-34" />
        <text
          x="54"
          y="164"
          fill="currentColor"
          stroke="none"
          fontSize="8"
          fontFamily="var(--font-mono), monospace"
        >
          categorias
        </text>
      </g>
      <Marker x={146} y={135} />
    </Frame>
  );
}

/** fig. 04 — painel: barras, linha de tendência e eixos com marcações. */
export function ChartBlueprint({ className }: { className?: string }) {
  const bars = [
    { x: 62, h: 46 },
    { x: 96, h: 78 },
    { x: 130, h: 58 },
    { x: 164, h: 96 },
  ];
  return (
    <Frame className={className}>
      <g stroke="currentColor" strokeWidth="0.75" strokeDasharray="3 4" opacity="0.45">
        <path d="M44 54h160M44 86h160M44 118h160" />
      </g>
      <g stroke="currentColor" strokeWidth="1.5">
        <path d="M44 24v126h164" />
        <path d="M40 54h4M40 86h4M40 118h4" />
        {bars.map((b) => (
          <rect key={b.x} x={b.x} y={150 - b.h} width="22" height={b.h} rx="2" />
        ))}
        <path d="M73 96L107 66L141 82L175 46" strokeDasharray="0" opacity="0.8" />
        {bars.map((b, i) => (
          <circle key={b.x} cx={b.x + 11} cy={[96, 66, 82, 46][i]} r="2.5" />
        ))}
      </g>
      <text
        x="208"
        y="164"
        textAnchor="end"
        fill="currentColor"
        fontSize="8"
        fontFamily="var(--font-mono), monospace"
        opacity="0.8"
      >
        mês
      </text>
      <Marker x={175} y={46} />
    </Frame>
  );
}

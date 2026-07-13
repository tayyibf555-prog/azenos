/**
 * Minimal 120×28 sparkline (§Metrics UI, projects list). No axes, no hover —
 * just a trend line with a terminal dot. Pure/server-safe SVG.
 */

export function Sparkline({
  points,
  color,
  width = 120,
  height = 28,
}: {
  points: number[];
  color: string;
  width?: number;
  height?: number;
}) {
  const pad = 2;
  const plotW = width - pad * 2;
  const plotH = height - pad * 2;

  if (points.length < 2) {
    return (
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden>
        <line
          x1={pad}
          x2={width - pad}
          y1={height / 2}
          y2={height / 2}
          stroke="var(--border-2)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      </svg>
    );
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const xFor = (i: number): number => pad + (i / (points.length - 1)) * plotW;
  const yFor = (v: number): number => pad + plotH - ((v - min) / span) * plotH;

  const d = points
    .map((v, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)} ${yFor(v).toFixed(1)}`)
    .join(" ");
  const lastX = xFor(points.length - 1);
  const lastY = yFor(points[points.length - 1] ?? min);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r={2} fill={color} />
    </svg>
  );
}

import { useCountUp } from "../hooks/useCountUp";

export type KpiColor = "blue" | "green" | "red" | "yellow" | "white";

const COLOR_MAP: Record<
  KpiColor,
  { border: string; glow: string; text: string }
> = {
  blue:   { border: "#388bfd", glow: "rgba(56,139,253,0.3)",   text: "#58a6ff" },
  green:  { border: "#238636", glow: "rgba(63,185,80,0.25)",   text: "#3fb950" },
  red:    { border: "#da3633", glow: "rgba(248,81,73,0.3)",    text: "#ff7b72" },
  yellow: { border: "#9e6a03", glow: "rgba(210,153,34,0.3)",   text: "#d29922" },
  white:  { border: "rgba(240,246,252,0.1)", glow: "transparent", text: "#e6edf3" },
};

type Props = {
  label: string;
  /** Numeric → animated count-up. String → displayed as-is. null → "—". */
  value: number | string | null;
  subtext?: string;
  color?: KpiColor;
};

function AnimatedNumber({ value }: { value: number }) {
  const n = useCountUp(value);
  return <>{n.toLocaleString()}</>;
}

export function KpiCard({ label, value, subtext, color = "white" }: Props) {
  const c = COLOR_MAP[color];
  return (
    <div
      style={{
        background: "#0d1117",
        border: `1px solid ${c.border}`,
        borderRadius: 8,
        padding: "12px 16px",
        textAlign: "center",
        boxShadow: `0 0 12px ${c.glow}`,
      }}
    >
      <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>
        {label}
      </div>
      <div
        style={{ fontSize: 22, fontWeight: 700, color: c.text, margin: "2px 0" }}
      >
        {value === null || value === undefined
          ? "—"
          : typeof value === "number"
          ? <AnimatedNumber value={value} />
          : value}
      </div>
      {subtext && (
        <div style={{ fontSize: 11, color: "#8b949e", marginTop: 2 }}>
          {subtext}
        </div>
      )}
    </div>
  );
}

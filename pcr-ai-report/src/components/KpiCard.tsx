import { useCountUp } from "../hooks/useCountUp";

export type KpiColor = "blue" | "green" | "red" | "yellow" | "white";

const COLOR_MAP: Record<
  KpiColor,
  { border: string; glow: string; text: string }
> = {
  blue:   { border: "rgba(var(--accent-rgb),0.55)", glow: "rgba(var(--accent-rgb),0.3)", text: "var(--accent)" },
  green:  { border: "rgba(var(--green-rgb),0.55)",  glow: "rgba(var(--green-rgb),0.25)", text: "var(--green)" },
  red:    { border: "rgba(var(--red-rgb),0.55)",    glow: "rgba(var(--red-rgb),0.3)",    text: "var(--red-text)" },
  yellow: { border: "rgba(var(--yellow-rgb),0.55)", glow: "rgba(var(--yellow-rgb),0.3)", text: "var(--yellow)" },
  white:  { border: "var(--border)", glow: "transparent", text: "var(--text)" },
};

type Props = {
  label: string;
  /** Numeric → animated count-up. String → displayed as-is. null → "—". */
  value: number | string | null;
  subtext?: string;
  color?: KpiColor;
  /** When false, title is shown only on the parent drag bar (e.g. reorder strips). */
  showLabel?: boolean;
};

function AnimatedNumber({ value }: { value: number }) {
  const n = useCountUp(value);
  return <>{n.toLocaleString()}</>;
}

export function KpiCard({
  label,
  value,
  subtext,
  color = "white",
  showLabel = true,
}: Props) {
  const c = COLOR_MAP[color];
  return (
    <div
      className={showLabel ? "kpi-card" : "kpi-card kpi-card--in-strip"}
      style={{
        background: "var(--bg)",
        border: `1px solid ${c.border}`,
        borderRadius: 8,
        padding: "12px 16px",
        textAlign: "center",
        boxShadow: `0 0 12px ${c.glow}`,
      }}
    >
      {showLabel && (
        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>
          {label}
        </div>
      )}
      <div
        className="kpi-card-value"
        style={{ fontSize: 22, fontWeight: 700, color: c.text, margin: "2px 0" }}
      >
        {value === null || value === undefined
          ? "—"
          : typeof value === "number"
          ? <AnimatedNumber value={value} />
          : value}
      </div>
      {(subtext || !showLabel) && (
        <div className="kpi-card-subtext" style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
          {subtext ?? " "}
        </div>
      )}
    </div>
  );
}

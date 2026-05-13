import { useEffect, useState } from "react";

/** Animates a numeric value from 0 to `target` over `duration` ms. */
export function useCountUp(target: number, duration = 600): number {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    if (!Number.isFinite(target)) {
      setDisplay(0);
      return;
    }
    setDisplay(0);   // reset before new animation starts
    let startTs = 0;
    let raf = 0;
    const step = (ts: number) => {
      if (startTs === 0) startTs = ts;
      const progress = Math.min((ts - startTs) / duration, 1);
      setDisplay(Math.round(progress * target));
      if (progress < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return display;
}

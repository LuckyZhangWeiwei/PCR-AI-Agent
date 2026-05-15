import { useCallback, useEffect, useState, type ReactNode } from "react";

type Props = {
  /** Persist expanded/collapsed in localStorage */
  storageKey?: string;
  title?: string;
  defaultOpen?: boolean;
  filters: ReactNode;
  footer: ReactNode;
};

function readOpen(storageKey: string | undefined, defaultOpen: boolean): boolean {
  if (!storageKey) return defaultOpen;
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === "0" || raw === "false") return false;
    if (raw === "1" || raw === "true") return true;
  } catch {
    /* ignore */
  }
  return defaultOpen;
}

export function CollapsibleQueryPanel({
  storageKey,
  title = "查询条件",
  defaultOpen = true,
  filters,
  footer,
}: Props) {
  const [open, setOpen] = useState(() => readOpen(storageKey, defaultOpen));

  useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, open ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [storageKey, open]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <div className={`query-panel${open ? "" : " query-panel--collapsed"}`}>
      <div className="query-panel-head">
        <button
          type="button"
          className="query-panel-toggle"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={storageKey ? `${storageKey}-body` : undefined}
        >
          <span className="query-panel-toggle-chevron" aria-hidden>
            {open ? "▼" : "▶"}
          </span>
          {title}
        </button>
        {!open ? (
          <div className="query-panel-head-footer">{footer}</div>
        ) : null}
      </div>
      {open ? (
        <div
          id={storageKey ? `${storageKey}-body` : undefined}
          className="query-panel-body"
        >
          {filters}
          <div className="query-panel-actions">{footer}</div>
        </div>
      ) : null}
    </div>
  );
}

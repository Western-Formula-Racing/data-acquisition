import { useEffect, useRef, useState } from "react";
import { useWcars } from "../../context/WcarsContext";
import { SEVERITY_LABEL, splitLeader } from "../../lib/wcars/ewdFormat";

export function EcamPanel() {
  const { alerts, clear, clearAll } = useWcars();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => setOverflow(el.scrollHeight > el.clientHeight + 1);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [alerts]);

  if (alerts.length === 0) {
    return (
      <div className="wcars-ecam wcars-ecam--empty" data-testid="ecam-empty">
        <span className="wcars-green">WCARS NORMAL</span>
      </div>
    );
  }

  return (
    <div className="wcars-ecam" data-testid="ecam">
      <div className="wcars-ecam-scroll" ref={scrollRef}>
        {alerts.map((a) => {
          const { label, value } = splitLeader(a.detail);
          return (
            <div key={a.id} className={`wcars-ecam-row wcars-${a.severity.toLowerCase()}`}>
              <span className="wcars-sev">{SEVERITY_LABEL[a.severity]}</span>
              <span className="wcars-title">{a.title}</span>
              <button
                className="wcars-clear-btn"
                aria-label="Clear alert"
                onClick={() => clear(a.id)}
              >
                ✕
              </button>
              <div className="wcars-detail">
                {value ? (
                  <span className="wcars-leader">
                    <span className="wcars-leader-lbl">{label}</span>
                    <span className="wcars-leader-dots" aria-hidden="true" />
                    <span className="wcars-leader-val">{value}</span>
                  </span>
                ) : (
                  <span className="wcars-leader-lbl">{label}</span>
                )}
              </div>
            </div>
          );
        })}
        <button className="wcars-clear-all" onClick={clearAll}>CLEAR ALL</button>
      </div>
      {/* EWD grey-stripe footer: green overflow arrow when scrollable, else STS */}
      <div className="wcars-ewd-footer">
        <span
          className={`wcars-overflow${overflow ? "" : " wcars-overflow--off"}`}
          aria-label={overflow ? "More alerts below" : undefined}
          aria-hidden={overflow ? undefined : true}
        >
          ▼
        </span>
        <span className="wcars-sts">STS</span>
      </div>
    </div>
  );
}

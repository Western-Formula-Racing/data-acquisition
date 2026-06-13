import { useWcars } from "../../context/WcarsContext";
import { SEVERITY_LABEL, splitLeader } from "../../lib/wcars/ewdFormat";

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}

export function AcarsPanel() {
  const { log } = useWcars();
  return (
    <div className="wcars-acars" data-testid="acars">
      {log.length === 0 ? (
        <div className="wcars-acars-empty">NO MESSAGES</div>
      ) : (
        log.map((a) => {
          const { label, value } = splitLeader(a.detail);
          return (
            <div
              key={a.id}
              className={`wcars-acars-row wcars-${a.severity.toLowerCase()}${a.replay ? " wcars-replay" : ""}`}
            >
              <span className="wcars-time">{fmtTime(a.ts)}</span>
              <span className="wcars-tag">{SEVERITY_LABEL[a.severity]}</span>
              <span className="wcars-title">{a.title}</span>
              <span className="wcars-detail">
                {value ? (
                  <span className="wcars-leader">
                    <span className="wcars-leader-lbl">{label}</span>
                    <span className="wcars-leader-dots" aria-hidden="true" />
                    <span className="wcars-leader-val">{value}</span>
                  </span>
                ) : (
                  <span className="wcars-leader-lbl">{label}</span>
                )}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}

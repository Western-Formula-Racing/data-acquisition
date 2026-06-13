import { PAGE_ORDER, SD_PAGES, type SdPageId } from "./pages";

interface Props {
  selected: SdPageId;
  inop: SdPageId[];
  onSelect: (id: SdPageId) => void;
  flashing?: SdPageId | null;
}

export function EcpButtonRow({ selected, inop, onSelect, flashing = null }: Props) {
  return (
    <div className="wcars-ecp-row" role="group" aria-label="System display pages">
      {PAGE_ORDER.map((id) => {
        const isInop = inop.includes(id);
        const cls = [
          "wcars-ecp",
          selected === id ? "wcars-ecp--on" : "",
          isInop ? "wcars-ecp--inop" : "",
          flashing === id ? "wcars-ecp--flash" : "",
        ].filter(Boolean).join(" ");
        return (
          <button
            key={id}
            type="button"
            className={cls}
            disabled={isInop}
            aria-pressed={selected === id}
            onClick={() => onSelect(id)}
          >
            <span className="wcars-ecp-legend">{SD_PAGES[id].label}</span>
            <span className="wcars-ecp-annunciator" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

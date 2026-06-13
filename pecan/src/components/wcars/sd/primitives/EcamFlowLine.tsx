interface Props {
  x1: number; y1: number; x2: number; y2: number;
  active?: boolean;
}

export function EcamFlowLine({ x1, y1, x2, y2, active = false }: Props) {
  return (
    <line
      className={`wcars-flow${active ? " wcars-flow--active" : ""}`}
      x1={x1} y1={y1} x2={x2} y2={y2}
    />
  );
}

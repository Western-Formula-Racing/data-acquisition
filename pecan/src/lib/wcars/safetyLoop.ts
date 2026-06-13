/** Shutdown-circuit / safety-loop conduction model.
 *
 * The FSAE shutdown circuit is a series chain of normally-open safety
 * contacts (IMD → AMS → BSPD → Latch). Current reaches a node only if every
 * upstream contact is closed. `seriesEnergized` returns, for each *node*
 * (including the source at index 0 and the output at the last index), whether
 * power reaches it.
 *
 * Example: seriesEnergized([true, false, true]) → [true, true, false, false]
 *   source live → after C0 (closed) live → after C1 (open) dead → stays dead.
 */
export function seriesEnergized(closed: boolean[]): boolean[] {
  const nodes: boolean[] = [true]; // source rail is always live
  for (const c of closed) {
    nodes.push(nodes[nodes.length - 1] && c);
  }
  return nodes;
}

/** Index of the first open contact (the loop break), or -1 if all closed. */
export function firstOpen(closed: boolean[]): number {
  return closed.findIndex((c) => !c);
}

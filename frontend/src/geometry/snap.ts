/**
 * Moving boxes: grid and gap snapping, and which boxes are on a storey.
 * Nothing here resolves an overlap -- rooms may overlap, and only a
 * requested carve (carve.ts) changes what is drawn. Everything returns
 * new Box objects; nothing is mutated.
 */
import { rectOf } from "./rect";
import { GAP_SNAP_M, GRID_M, type Box } from "./types";

export function snapToGrid(v: number): number {
  return Math.round(v / GRID_M) * GRID_M;
}

/** Everything drawn on `level`: rooms on it, and anything spanning it. A
 * zone added from the schedule but not yet placed (`placed === false`)
 * has no position and takes no part in the plan, carving or the plot --
 * this is the one place that is enforced, so every reader downstream
 * already has it applied. */
export function liveBoxes(boxes: Box[], level: number): Box[] {
  return boxes.filter((b) => !b.deleted && b.placed !== false && b.level <= level && level <= b.levelTo);
}

/** True where `level` is above the zone's own floor: the zone is not a
 * room on this storey, it is the void a tall room leaves in it. Drawn
 * crossed out and marked "Open to below", and no door leads into it,
 * because there is no floor there to walk on.
 *
 * A stair is the exception: it is exactly a hole you do walk through, so
 * it keeps its arrows on every storey it connects. */
export function isOpenToBelow(b: Box, level: number): boolean {
  return b.level < level && level <= b.levelTo && b.roomType !== "stair";
}

/** Sub-meter gap to the nearest facing neighbour along one axis, if any. */
function findNearestGapDelta(el: Box, live: Box[], axis: "x" | "y"): number | null {
  const r = rectOf(el);
  let bestGap = Infinity;
  let bestDelta: number | null = null;
  for (const other of live) {
    if (other.id === el.id) continue;
    const o = rectOf(other);
    if (axis === "x") {
      const yOverlap = Math.min(r.top + r.height, o.top + o.height) - Math.max(r.top, o.top);
      if (yOverlap <= 0) continue;
      const gapRight = o.left - (r.left + r.width);
      if (gapRight > 0.02 && gapRight < GAP_SNAP_M && gapRight < bestGap) {
        bestGap = gapRight;
        bestDelta = gapRight;
      }
      const gapLeft = r.left - (o.left + o.width);
      if (gapLeft > 0.02 && gapLeft < GAP_SNAP_M && gapLeft < bestGap) {
        bestGap = gapLeft;
        bestDelta = -gapLeft;
      }
    } else {
      const xOverlap = Math.min(r.left + r.width, o.left + o.width) - Math.max(r.left, o.left);
      if (xOverlap <= 0) continue;
      const gapDown = o.top - (r.top + r.height);
      if (gapDown > 0.02 && gapDown < GAP_SNAP_M && gapDown < bestGap) {
        bestGap = gapDown;
        bestDelta = gapDown;
      }
      const gapUp = r.top - (o.top + o.height);
      if (gapUp > 0.02 && gapUp < GAP_SNAP_M && gapUp < bestGap) {
        bestGap = gapUp;
        bestDelta = -gapUp;
      }
    }
  }
  return bestDelta;
}

export function snapToNearbyNeighbors(el: Box, live: Box[]): Box {
  let out = el;
  const dx = findNearestGapDelta(out, live, "x");
  if (dx !== null) out = { ...out, left: out.left + dx };
  const dy = findNearestGapDelta(out, live, "y");
  if (dy !== null) out = { ...out, top: out.top + dy };
  return out;
}

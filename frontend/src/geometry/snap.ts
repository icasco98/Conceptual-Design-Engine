/**
 * Moving boxes: grid and gap snapping, and which boxes are on a storey.
 * Nothing here resolves an overlap -- rooms may overlap, and only a
 * requested carve (carve.ts) changes what is drawn. Everything returns
 * new Box objects; nothing is mutated.
 */
import { rectOf } from "./rect";
import { GAP_SNAP_M, GRID_M, type Box, type Point, type Poly } from "./types";

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

/** How close a dragged polygon corner or wall may land to another zone's
 * own corner or wall before it locks onto it exactly. */
export const POINT_SNAP_M = 0.25;

/** Within a hair of parallel: a wall drag only snaps flush against
 * another wall running the same way, never a crosswise one. */
const PARALLEL_SIN = 0.09; // ~5 degrees

/** The closest point on any of `outlines` to `p` -- one of their own
 * corners if within `POINT_SNAP_M` (corners win over a mid-wall point at
 * the same reach, since landing exactly on another room's corner is the
 * more useful alignment), else the closest point along one of their
 * walls, else null.
 *
 * Both `p` and `outlines` are read in whatever one frame the caller put
 * them in -- the dragged zone's own local frame, once its neighbours'
 * outlines have been turned into it with `poly.ts`'s `pageToLocalPoly`,
 * so a snap works the same under any rotation. */
export function nearestNeighborPoint(p: Point, outlines: Poly[]): Point | null {
  let corner: Point | null = null;
  let cornerDist = POINT_SNAP_M;
  let edge: Point | null = null;
  let edgeDist = POINT_SNAP_M;
  for (const poly of outlines) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const d = Math.hypot(p[0] - a[0], p[1] - a[1]);
      if (d < cornerDist) {
        cornerDist = d;
        corner = a;
      }
      const b = poly[(i + 1) % poly.length];
      const abx = b[0] - a[0];
      const aby = b[1] - a[1];
      const len2 = abx * abx + aby * aby;
      if (len2 < 1e-9) continue;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2));
      const ex = a[0] + t * abx;
      const ey = a[1] + t * aby;
      const de = Math.hypot(p[0] - ex, p[1] - ey);
      if (de < edgeDist) {
        edgeDist = de;
        edge = [ex, ey];
      }
    }
  }
  return corner ?? edge;
}

/** The extra push, along `normal`, that would bring the segment `a`-`b`
 * (already pushed this far) exactly flush with a nearby wall of one of
 * `outlines` that runs the same way, or 0 if none is within
 * `POINT_SNAP_M`. Read in the same one frame as `nearestNeighborPoint`. */
export function wallSnapAdjust(a: Point, b: Point, normal: Point, outlines: Poly[]): number {
  const wx = b[0] - a[0];
  const wy = b[1] - a[1];
  const wallLen = Math.hypot(wx, wy);
  if (wallLen < 1e-6) return 0;
  const ux = wx / wallLen;
  const uy = wy / wallLen;
  let best = 0;
  let bestAbs = POINT_SNAP_M;
  for (const poly of outlines) {
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i];
      const p1 = poly[(i + 1) % poly.length];
      const ex = p1[0] - p0[0];
      const ey = p1[1] - p0[1];
      const edgeLen = Math.hypot(ex, ey);
      if (edgeLen < 1e-6) continue;
      // Parallel or anti-parallel, within PARALLEL_SIN.
      if (Math.abs(ux * (ey / edgeLen) - uy * (ex / edgeLen)) > PARALLEL_SIN) continue;
      const gap = (p0[0] - a[0]) * normal[0] + (p0[1] - a[1]) * normal[1];
      if (Math.abs(gap) < bestAbs) {
        bestAbs = Math.abs(gap);
        best = gap;
      }
    }
  }
  return best;
}

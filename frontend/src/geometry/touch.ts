/**
 * "Make the selected zones touch."
 *
 * Each selected zone finds the nearest other zone on its storey -- by
 * the shortest gap between their outlines, not their centres -- and if
 * that gap is under TOUCH_REACH_M it slides straight across it until the
 * two outlines meet. Rotation does not matter: two zones at 30 degrees
 * with parallel walls meet flush along the wall's normal; a square next
 * to a turned one meets corner-to-wall along the shortest line between
 * them. A circle meets tangent. Nothing else moves, and a zone already
 * touching or overlapping something stays where it is.
 *
 * Selected zones are handled one at a time and may meet each other, so
 * two selected zones half a metre apart close on one another.
 */
import { polyOfBox } from "./poly";
import { boxesTrulyIntersect } from "./rect";
import type { Box, Point, Poly } from "./types";

const TOUCH_REACH_M = 1.0;

/** Closest points between two segments, and the distance. */
function segmentsClosest(a0: Point, a1: Point, b0: Point, b1: Point): { d: number; pa: Point; pb: Point } {
  // Sample the closest point of each segment to the other's endpoints
  // and take the best: exact for non-crossing segments of convex hulls
  // that do not overlap, which is the only case a gap exists.
  const best = { d: Infinity, pa: a0, pb: b0 };
  const consider = (p: Point, q0: Point, q1: Point, pIsA: boolean) => {
    const c = closestOnSegment(p, q0, q1);
    const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
    if (d < best.d) {
      best.d = d;
      best.pa = pIsA ? p : c;
      best.pb = pIsA ? c : p;
    }
  };
  consider(a0, b0, b1, true);
  consider(a1, b0, b1, true);
  consider(b0, a0, a1, false);
  consider(b1, a0, a1, false);
  return best;
}

function closestOnSegment(p: Point, q0: Point, q1: Point): Point {
  const dx = q1[0] - q0[0];
  const dy = q1[1] - q0[1];
  const len2 = dx * dx + dy * dy;
  if (!len2) return q0;
  const t = Math.max(0, Math.min(1, ((p[0] - q0[0]) * dx + (p[1] - q0[1]) * dy) / len2));
  return [q0[0] + t * dx, q0[1] + t * dy];
}

/** Shortest gap between two outlines and the two points that realise it. */
export function polyGap(a: Poly, b: Poly): { d: number; pa: Point; pb: Point } {
  const best = { d: Infinity, pa: a[0], pb: b[0] };
  for (let i = 0; i < a.length; i++) {
    const a0 = a[i];
    const a1 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const c = segmentsClosest(a0, a1, b[j], b[(j + 1) % b.length]);
      if (c.d < best.d) Object.assign(best, c);
    }
  }
  return best;
}

/** The move that brings `mover` to touch its nearest neighbour among
 * `others`, or null when nothing is within reach or it already touches. */
export function touchDelta(mover: Box, others: Box[]): Point | null {
  if (others.some((o) => boxesTrulyIntersect(mover, o))) return null;
  const mine = polyOfBox(mover);
  let best: { d: number; pa: Point; pb: Point } | null = null;
  for (const o of others) {
    if (o.id === mover.id) continue;
    const gap = polyGap(mine, polyOfBox(o));
    if (!best || gap.d < best.d) best = gap;
  }
  if (!best || best.d >= TOUCH_REACH_M || best.d < 0.005) return null;
  return [best.pb[0] - best.pa[0], best.pb[1] - best.pa[1]];
}

/** Every box in `ids`, moved to touch, one at a time. */
export function touchSelected(live: Box[], ids: string[]): Box[] {
  let out = live;
  for (const id of ids) {
    const mover = out.find((b) => b.id === id);
    if (!mover) continue;
    const delta = touchDelta(mover, out.filter((b) => b.id !== id));
    if (!delta) continue;
    out = out.map((b) => (b.id === id ? { ...b, left: b.left + delta[0], top: b.top + delta[1] } : b));
  }
  return out;
}

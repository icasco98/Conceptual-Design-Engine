/**
 * Door arrows, as things you own.
 *
 * An arrow belongs to one zone (its host) and sits on one of that zone's
 * walls, always perpendicular to it: it is stored as which wall and how
 * far along it, in the host's own frame, so it turns with the host and
 * moves with it. On a circle the "wall" is the rim, and the arrow is
 * radial. Its direction is either out of the host or into it.
 *
 * `suggestArrows` proposes one arrow per zone by walking the touching
 * graph out from the entry (or the stair on an upper storey), plus one
 * for each carve, hosted on the carving zone and pointing into the zone
 * it cuts. Suggestions only add arrows to zones that have none pointing
 * at them yet; everything a person has placed is left alone. A zone that
 * is open to below on this storey (snap.ts) is skipped entirely: there
 * is no floor there to walk on.
 *
 * Every arrow this proposes is `interior` -- a door between two zones.
 * The exterior doors (`exterior-main`, `exterior-side`) are never
 * suggested: where the building's own front and side doors are is a
 * decision for a person, not a walk of the touching graph, so they are
 * placed by hand with their own tools and left alone here.
 */
import { displayShapes } from "./carve";
import { pageToLocalPoly, localToPagePoly, localPolyOf, frameOf } from "./poly";
import { rectOf, centerOf } from "./rect";
import { boxesTrulyIntersect } from "./rect";
import { isOpenToBelow } from "./snap";
import { DOOR_INSET_M, type Arrow, type Box, type Point, type Poly } from "./types";
import { touchingEdges, touchMid } from "./doors";

/** Twice a polygon's signed area (shoelace; only the sign is used, so
 * there is no need to halve it). Positive for the winding a rectangle's
 * own corners are listed in (poly.ts's `rectPolyOf`) -- a hand-drawn
 * polygon may run either way, so this is worked out rather than assumed,
 * to get its walls' outward side right regardless. */
function signedArea(poly: Poly): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return a;
}

/** The point at parameter `t` along a polygon's own edge `side` (from
 * vertex `side` to the next one, wrapping), and its outward normal. */
function polygonWallPoint(poly: Poly, side: number, t: number): { p: Point; n: Point } {
  const n = poly.length;
  const i = ((side % n) + n) % n;
  const a = poly[i];
  const b = poly[(i + 1) % n];
  const p: Point = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const len = Math.hypot(ex, ey) || 1;
  const outward = signedArea(poly) >= 0 ? 1 : -1;
  return { p, n: [(outward * ey) / len, (-outward * ex) / len] };
}

/** The point on the host's outline for (side, t), and the outward normal
 * there, both in the host's LOCAL frame. On a polygon, `side` is which
 * of its own walls (edge `side` to edge `side + 1`, however many it
 * has) -- not one of a rectangle's fixed four. */
function wallPointLocal(host: Box, side: number, t: number): { p: Point; n: Point } {
  if (host.shape === "circle") {
    const r = rectOf(host);
    const a = t * Math.PI * 2;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const p: Point = [cx + (r.width / 2) * Math.cos(a), cy + (r.height / 2) * Math.sin(a)];
    // Normal of an ellipse at parameter a.
    const nx = Math.cos(a) / (r.width / 2);
    const ny = Math.sin(a) / (r.height / 2);
    const len = Math.hypot(nx, ny) || 1;
    return { p, n: [nx / len, ny / len] };
  }
  if (host.shape === "polygon" && host.points?.length) {
    return polygonWallPoint(localPolyOf(host), side, t);
  }
  const r = rectOf(host);
  const x1 = r.left + r.width;
  const y1 = r.top + r.height;
  switch (side % 4) {
    case 0:
      return { p: [r.left + t * r.width, r.top], n: [0, -1] };
    case 1:
      return { p: [x1, r.top + t * r.height], n: [1, 0] };
    case 2:
      return { p: [x1 - t * r.width, y1], n: [0, 1] };
    default:
      return { p: [r.left, y1 - t * r.height], n: [-1, 0] };
  }
}

/** The arrow's two ends on the page, tail first. */
export function arrowSegment(host: Box, arrow: Arrow): [Point, Point] {
  const { p, n } = wallPointLocal(host, arrow.side, arrow.t);
  const s = arrow.dir;
  const tail: Point = [p[0] - s * n[0] * DOOR_INSET_M, p[1] - s * n[1] * DOOR_INSET_M];
  const head: Point = [p[0] + s * n[0] * DOOR_INSET_M, p[1] + s * n[1] * DOOR_INSET_M];
  const fr = frameOf(host);
  const [a, b] = localToPagePoly([tail, head], fr);
  return [a, b];
}

/** The point on a segment `a`-`b` nearest `q`, clamped to the segment
 * rather than its infinite line, and how far along (0..1) it is. */
function nearestOnSegment(q: Point, a: Point, b: Point): { p: Point; t: number } {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const len2 = ex * ex + ey * ey;
  const t = len2 < 1e-9 ? 0 : clamp01(((q[0] - a[0]) * ex + (q[1] - a[1]) * ey) / len2);
  return { p: [a[0] + t * ex, a[1] + t * ey], t };
}

/** The wall point on `host` nearest a page-frame point: which side, how
 * far along. What dragging an arrow snaps to. On a polygon this checks
 * every one of its own walls, not a rectangle's fixed four. */
export function nearestWallPoint(host: Box, page: Point): { side: number; t: number } {
  const fr = frameOf(host);
  const [q] = pageToLocalPoly([page], fr);
  if (host.shape === "circle") {
    const r = rectOf(host);
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const a = Math.atan2((q[1] - cy) / (r.height / 2), (q[0] - cx) / (r.width / 2));
    return { side: 0, t: ((a / (Math.PI * 2)) % 1 + 1) % 1 };
  }
  if (host.shape === "polygon" && host.points?.length) {
    const poly = localPolyOf(host);
    let best = { side: 0, t: 0, d: Infinity };
    for (let i = 0; i < poly.length; i++) {
      const { p, t } = nearestOnSegment(q, poly[i], poly[(i + 1) % poly.length]);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < best.d) best = { side: i, t, d };
    }
    return { side: best.side, t: best.t };
  }
  const r = rectOf(host);
  const x1 = r.left + r.width;
  const y1 = r.top + r.height;
  const candidates: { side: number; t: number; d: number }[] = [
    { side: 0, t: clamp01((q[0] - r.left) / r.width), d: Math.abs(q[1] - r.top) },
    { side: 1, t: clamp01((q[1] - r.top) / r.height), d: Math.abs(q[0] - x1) },
    { side: 2, t: clamp01((x1 - q[0]) / r.width), d: Math.abs(q[1] - y1) },
    { side: 3, t: clamp01((y1 - q[1]) / r.height), d: Math.abs(q[0] - r.left) },
  ];
  // Distance to the wall as a segment, not the infinite line, so a point
  // off a corner picks the wall it is actually nearest.
  for (const c of candidates) {
    const { p } = wallPointLocal(host, c.side, c.t);
    c.d = Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  candidates.sort((a, b) => a.d - b.d);
  return { side: candidates[0].side, t: candidates[0].t };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

let counter = 0;
export function newArrowId(): string {
  counter += 1;
  return `arrow:${Date.now().toString(36)}:${counter}`;
}

const TOUCH_TOL_M = 0.04;

/** One arrow per zone reached by walking the touching graph from the
 * entry (or the stair), hosted on the zone it was reached from and
 * pointing into it; plus one per carve, hosted on the carver. Nothing is
 * added for a zone that already has an arrow pointing into it. */
export function suggestArrows(all: Box[], existing: Arrow[], level: number, autoCarve: boolean): Arrow[] {
  // A zone open to below is a void on this storey: no door leads into it
  // and none leads out of it, so it takes no part in the walk.
  const live = all.filter((b) => !isOpenToBelow(b, level));
  const covered = new Set(existing.filter((a) => a.targetId).map((a) => a.targetId!));
  const out: Arrow[] = [];
  const add = (host: Box, target: Box, side: number, t: number) => {
    if (covered.has(target.id)) return;
    covered.add(target.id);
    out.push({ id: newArrowId(), level, hostId: host.id, targetId: target.id, side, t, dir: 1, kind: "interior" });
  };

  // Carves first: a room cut into another is entered from the carver.
  for (const victim of live) {
    for (const carverId of victim.carvedBy) {
      const carver = live.find((b) => b.id === carverId);
      if (!carver || !boxesTrulyIntersect(carver, victim)) continue;
      const { side, t } = nearestWallPoint(carver, centerOf(rectOf(victim)));
      add(carver, victim, side, t);
    }
  }

  // Then the walk from the entry, through every shared wall: a rotated
  // box's own turned edges, a hand-drawn polygon's vertices, and the
  // boundary a carve leaves behind all read the same way -- the same
  // polygon test `buildTouchGraph` uses for circulation, run on each
  // zone's actual outline right now (`displayShapes`, which already
  // covers the carve loop above too; a zone reached only through a
  // carve is picked up here as well, since the loop above marks it
  // `covered` without adding it to the walk).
  const shapes = displayShapes(live, autoCarve);
  const polyById = new Map(shapes.map((s) => [s.id, s.page]));
  let start = live.findIndex((b) => b.isEntry);
  if (start === -1) start = live.findIndex((b) => b.roomType === "stair");
  if (start === -1) return out;
  const visited = new Set<string>([live[start].id]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    const host = live[cur];
    const hostPoly = polyById.get(host.id);
    if (!hostPoly) continue;
    for (let j = 0; j < live.length; j++) {
      const other = live[j];
      if (visited.has(other.id)) continue;
      const otherPoly = polyById.get(other.id);
      if (!otherPoly) continue;
      const touches = touchingEdges(hostPoly, otherPoly, TOUCH_TOL_M);
      if (!touches.length) continue;
      visited.add(other.id);
      queue.push(j);
      const { side, t } = nearestWallPoint(host, touchMid(touches[0]));
      add(host, other, side, t);
    }
  }
  return out;
}

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
 * at them yet; everything a person has placed is left alone.
 */
import { pageToLocalPoly, localToPagePoly, frameOf } from "./poly";
import { rectOf, centerOf } from "./rect";
import { boxesTrulyIntersect } from "./rect";
import { DOOR_INSET_M, type Arrow, type Box, type Point } from "./types";
import { touchingEdge } from "./doors";

/** Sides of a rectangle in its own frame, clockwise from the top. */
export const SIDES = ["top", "right", "bottom", "left"] as const;

/** The point on the host's outline for (side, t), and the outward normal
 * there, both in the host's LOCAL frame. */
export function wallPointLocal(host: Box, side: number, t: number): { p: Point; n: Point } {
  const r = rectOf(host);
  if (host.shape === "circle") {
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

/** The wall point on `host` nearest a page-frame point: which side, how
 * far along. What dragging an arrow snaps to. */
export function nearestWallPoint(host: Box, page: Point): { side: number; t: number } {
  const fr = frameOf(host);
  const [q] = pageToLocalPoly([page], fr);
  const r = rectOf(host);
  if (host.shape === "circle") {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const a = Math.atan2((q[1] - cy) / (r.height / 2), (q[0] - cx) / (r.width / 2));
    return { side: 0, t: ((a / (Math.PI * 2)) % 1 + 1) % 1 };
  }
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
export function suggestArrows(live: Box[], existing: Arrow[], level: number): Arrow[] {
  const covered = new Set(existing.filter((a) => a.targetId).map((a) => a.targetId!));
  const out: Arrow[] = [];
  const add = (host: Box, target: Box, side: number, t: number) => {
    if (covered.has(target.id)) return;
    covered.add(target.id);
    out.push({ id: newArrowId(), level, hostId: host.id, targetId: target.id, side, t, dir: 1 });
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

  // Then the walk from the entry, through shared walls, unrotated
  // rectangles only: a rotated or round zone has no wall to share.
  const plain = (b: Box) => b.shape === "rect" && !b.rotation;
  let start = live.findIndex((b) => b.isEntry);
  if (start === -1) start = live.findIndex((b) => b.roomType === "stair");
  if (start === -1) return out;
  const visited = new Set<string>([live[start].id]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    const host = live[cur];
    for (let j = 0; j < live.length; j++) {
      const other = live[j];
      if (visited.has(other.id) || !plain(host) || !plain(other)) continue;
      const touch = touchingEdge(rectOf(host), rectOf(other), TOUCH_TOL_M);
      if (!touch) continue;
      visited.add(other.id);
      queue.push(j);
      const { side, t } = nearestWallPoint(host, touch.mid);
      add(host, other, side, t);
    }
  }
  return out;
}

import { OVERLAP_EPS, type Box, type Obb, type Point, type Rect } from "./types";

export function rectOf(b: Box): Rect {
  return { left: b.left, top: b.top, width: b.width, height: b.height };
}

export function centerOf(r: Rect): Point {
  return [r.left + r.width / 2, r.top + r.height / 2];
}

/** The axis-aligned bounding box of the rotated shape, centered on the
 * same point. Bigger than the true footprint by design: it is what the
 * envelope clamp and push magnitudes work off once a real overlap is
 * established. Whether two boxes really overlap is decided by the SAT
 * test on the true shape (obbsSeparated). */
export function effectiveRectOf(b: Box): Rect {
  if (!b.rotation) return rectOf(b);
  const rad = (b.rotation * Math.PI) / 180;
  const cosA = Math.abs(Math.cos(rad));
  const sinA = Math.abs(Math.sin(rad));
  const bw = b.width * cosA + b.height * sinA;
  const bh = b.width * sinA + b.height * cosA;
  const cx = b.left + b.width / 2;
  const cy = b.top + b.height / 2;
  return { left: cx - bw / 2, top: cy - bh / 2, width: bw, height: bh };
}

export function obbOf(b: Box): Obb {
  const rad = (b.rotation * Math.PI) / 180;
  return {
    cx: b.left + b.width / 2,
    cy: b.top + b.height / 2,
    hw: b.width / 2,
    hh: b.height / 2,
    ax: [Math.cos(rad), Math.sin(rad)],
    ay: [-Math.sin(rad), Math.cos(rad)],
  };
}

export function cornersOfObb(o: Obb): Point[] {
  const local: Point[] = [
    [-o.hw, -o.hh],
    [o.hw, -o.hh],
    [o.hw, o.hh],
    [-o.hw, o.hh],
  ];
  return local.map((p) => [
    o.cx + p[0] * o.ax[0] + p[1] * o.ay[0],
    o.cy + p[0] * o.ax[1] + p[1] * o.ay[1],
  ]);
}

function projection(o: Obb, axis: Point): number {
  return (
    o.hw * Math.abs(o.ax[0] * axis[0] + o.ax[1] * axis[1]) +
    o.hh * Math.abs(o.ay[0] * axis[0] + o.ay[1] * axis[1])
  );
}

/** Separating axis theorem over the four candidate axes. True only when a
 * genuine gap exists along at least one of them. */
export function obbsSeparated(a: Obb, b: Obb): boolean {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  for (const axis of [a.ax, a.ay, b.ax, b.ay]) {
    const dist = Math.abs(dx * axis[0] + dy * axis[1]);
    if (dist > projection(a, axis) + projection(b, axis) + OVERLAP_EPS) return true;
  }
  return false;
}

/** How far, and which way, A must move to just clear B, along the
 * shallowest separating axis of their true shapes. Null when apart. */
export function obbPenetration(a: Obb, b: Obb): Point | null {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  let best = Infinity;
  let bestAxis: Point | null = null;
  for (const axis of [a.ax, a.ay, b.ax, b.ay]) {
    const dist = Math.abs(dx * axis[0] + dy * axis[1]);
    const depth = projection(a, axis) + projection(b, axis) - dist;
    // Answer the same question obbsSeparated answers, on the same side of
    // the tolerance. It calls a pair separated only once the gap exceeds
    // OVERLAP_EPS, so anything short of that still counts as penetrating
    // here -- otherwise the two functions disagree inside the band.
    if (depth < -OVERLAP_EPS) return null;
    if (depth < best) {
      best = depth;
      bestAxis = axis;
    }
  }
  if (!bestAxis) return null;
  const along = dx * bestAxis[0] + dy * bestAxis[1];
  const sign = along > 0 ? -1 : 1;
  // Clear the tolerance band rather than landing inside it. Moving by the
  // bare depth leaves the pair exactly touching, which obbPenetration then
  // reads as separated and obbsSeparated reads as overlapping: the caller
  // is told to push, pushes, and is told to push again with no distance
  // left to move. That deadlock is what leaves rooms drawn on top of each
  // other after a rotation. Four millimetres costs nothing on a house.
  const clear = best + 2 * OVERLAP_EPS;
  return [bestAxis[0] * clear * sign, bestAxis[1] * clear * sign];
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.left + OVERLAP_EPS < b.left + b.width &&
    b.left + OVERLAP_EPS < a.left + a.width &&
    a.top + OVERLAP_EPS < b.top + b.height &&
    b.top + OVERLAP_EPS < a.top + a.height
  );
}

/** The real overlap test: AABBs when neither is rotated (they agree with
 * the shape exactly), SAT on the true shapes otherwise. */
export function boxesTrulyIntersect(a: Box, b: Box): boolean {
  if (!a.rotation && !b.rotation) return rectsOverlap(effectiveRectOf(a), effectiveRectOf(b));
  return !obbsSeparated(obbOf(a), obbOf(b));
}

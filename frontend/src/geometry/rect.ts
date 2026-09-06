import { polyOfBox } from "./poly";
import { OVERLAP_EPS, type Box, type Obb, type Point, type Poly, type Rect } from "./types";

export function rectOf(b: Box): Rect {
  return { left: b.left, top: b.top, width: b.width, height: b.height };
}

export function centerOf(r: Rect): Point {
  return [r.left + r.width / 2, r.top + r.height / 2];
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

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.left + OVERLAP_EPS < b.left + b.width &&
    b.left + OVERLAP_EPS < a.left + a.width &&
    a.top + OVERLAP_EPS < b.top + b.height &&
    b.top + OVERLAP_EPS < a.top + a.height
  );
}

/** Separating axis theorem for two convex polygons: true when a gap
 * exists along some edge normal of either. Touching does not count. */
export function convexPolysSeparated(a: Poly, b: Poly): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const nx = q[1] - p[1];
      const ny = -(q[0] - p[0]);
      const len = Math.hypot(nx, ny);
      if (!len) continue;
      const ax = nx / len;
      const ay = ny / len;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const v of a) {
        const d = v[0] * ax + v[1] * ay;
        aMin = Math.min(aMin, d);
        aMax = Math.max(aMax, d);
      }
      for (const v of b) {
        const d = v[0] * ax + v[1] * ay;
        bMin = Math.min(bMin, d);
        bMax = Math.max(bMax, d);
      }
      if (aMax < bMin + OVERLAP_EPS || bMax < aMin + OVERLAP_EPS) return true;
    }
  }
  return false;
}

/** The real overlap test: AABBs when both are unrotated rectangles (they
 * agree with the shape exactly), SAT on the true outlines otherwise --
 * rectangles and ellipses are both convex. Touching edges do not count. */
export function boxesTrulyIntersect(a: Box, b: Box): boolean {
  const plain = a.shape === "rect" && b.shape === "rect";
  if (plain && !a.rotation && !b.rotation) return rectsOverlap(rectOf(a), rectOf(b));
  if (plain) return !obbsSeparated(obbOf(a), obbOf(b));
  return !convexPolysSeparated(polyOfBox(a), polyOfBox(b));
}

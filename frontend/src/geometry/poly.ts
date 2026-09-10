/**
 * Boolean polygon arithmetic, all of it through polygon-clipping (MIT).
 * Rings are plain [x, y] arrays; the library takes/returns GeoJSON-ish
 * nesting -- a Polygon is [outerRing, ...holes], a MultiPolygon a list of
 * those -- with rings explicitly closed, which ringToPoly strips back off.
 */
import polygonClipping from "polygon-clipping";

import { CIRCLE_SEGMENTS, type Box, type Frame, type Point, type Poly, type Rect } from "./types";

type Ring = Point[];
type Geom = Ring[];

export function polyToGeom(poly: Poly): Geom {
  return [poly.map((p) => [p[0], p[1]] as Point)];
}

export function ringToPoly(ring: readonly (readonly number[])[]): Poly {
  const out: Poly = ring.map((p) => [p[0], p[1]]);
  if (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) out.pop();
  }
  return out;
}

export function polyArea(poly: Poly): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return Math.abs(a) / 2;
}

/** Union of many polygons, as a list of polygons each [outer, ...holes]. */
export function unionPolys(polys: Poly[]): Poly[][] {
  if (!polys.length) return [];
  const geoms = polys.map(polyToGeom);
  try {
    return polygonClipping.union(geoms[0], ...geoms.slice(1)).map((poly) => poly.map(ringToPoly));
  } catch {
    return geoms.map((g) => g.map(ringToPoly));
  }
}

/** Area shared by two polygons, in square metres -- 0 when they do not
 * overlap at all. Falls back to 0 rather than throwing if the library
 * cannot handle a degenerate pair, the same defensive shape `unionPolys`
 * above already takes: a wrong-but-conservative 0 here means a check
 * reports "these do not overlap", which is what it would have concluded
 * anyway without an answer. */
export function polyOverlapArea(a: Poly, b: Poly): number {
  try {
    const parts = polygonClipping.intersection(polyToGeom(a), polyToGeom(b));
    let area = 0;
    for (const poly of parts) {
      // [outer, ...holes] -- the holes subtract, same convention as the
      // rest of this file.
      poly.forEach((ring, i) => {
        const ringArea = polyArea(ringToPoly(ring));
        area += i === 0 ? ringArea : -ringArea;
      });
    }
    return Math.max(0, area);
  } catch {
    return 0;
  }
}

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function bboxOf(poly: Poly): BBox {
  const b: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of poly) {
    b.minX = Math.min(b.minX, p[0]);
    b.maxX = Math.max(b.maxX, p[0]);
    b.minY = Math.min(b.minY, p[1]);
    b.maxY = Math.max(b.maxY, p[1]);
  }
  return b;
}

export function rectPolyOf(r: Rect): Poly {
  return [
    [r.left, r.top],
    [r.left + r.width, r.top],
    [r.left + r.width, r.top + r.height],
    [r.left, r.top + r.height],
  ];
}

/** The ellipse inscribed in a rectangle, as a polygon. */
function ellipsePolyOf(r: Rect): Poly {
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const out: Poly = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const t = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    out.push([cx + (r.width / 2) * Math.cos(t), cy + (r.height / 2) * Math.sin(t)]);
  }
  return out;
}

/** The box's outline in its OWN frame -- unrotated, axis-aligned -- a
 * rectangle, the ellipse inside it, or a hand-drawn polygon's vertices
 * scaled out of their 0..1 fractions and into the bounding box. */
export function localPolyOf(b: Box): Poly {
  const r = { left: b.left, top: b.top, width: b.width, height: b.height };
  if (b.shape === "circle") return ellipsePolyOf(r);
  if (b.shape === "polygon" && b.points?.length) return b.points.map(([fx, fy]) => [b.left + fx * b.width, b.top + fy * b.height]);
  return rectPolyOf(r);
}

/** The box's outline on the page: its local outline turned by its
 * rotation. Every overlap test, carve and outline reads this. */
export function polyOfBox(b: Box): Poly {
  return localToPagePoly(localPolyOf(b), frameOf(b));
}

/** The point on `poly`'s own boundary nearest `p` -- on an edge, not
 * merely somewhere inside it. What a click or drag near a zone actually
 * resolves to: `poly` is a zone's current, post-carve outline, so a
 * stretch a carve has taken away is no longer a candidate, exactly as a
 * stretch it never had never was. */
export function nearestPointOnPoly(poly: Poly, p: Point): Point {
  let best: Point = poly[0] ?? p;
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len2 = ex * ex + ey * ey;
    const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / len2));
    const q: Point = [a[0] + t * ex, a[1] + t * ey];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/** Whether `p` sits within `tol` of `poly`'s own boundary. What decides
 * whether a placed door is still on a wall that is actually there. */
export function pointOnPolyBoundary(poly: Poly, p: Point, tol: number): boolean {
  const q = nearestPointOnPoly(poly, p);
  return Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol;
}

/** A box's own frame: for a rotated box the world is turned around it so
 * the box is an axis-aligned rectangle again and every carve, strip and
 * minimum-rectangle test works unchanged. For an unrotated box both
 * transforms are no-ops. */
export function frameOf(b: Box): Frame {
  const rad = (b.rotation * Math.PI) / 180;
  return {
    cx: b.left + b.width / 2,
    cy: b.top + b.height / 2,
    cos: Math.cos(rad),
    sin: Math.sin(rad),
    rotated: rad !== 0,
  };
}

export function pageToLocalPoly(poly: Poly, fr: Frame): Poly {
  if (!fr.rotated) return poly;
  return poly.map((p) => {
    const dx = p[0] - fr.cx;
    const dy = p[1] - fr.cy;
    return [fr.cx + dx * fr.cos + dy * fr.sin, fr.cy - dx * fr.sin + dy * fr.cos];
  });
}

export function localToPagePoly(poly: Poly, fr: Frame): Poly {
  if (!fr.rotated) return poly;
  return poly.map((p) => {
    const dx = p[0] - fr.cx;
    const dy = p[1] - fr.cy;
    return [fr.cx + dx * fr.cos - dy * fr.sin, fr.cy + dx * fr.sin + dy * fr.cos];
  });
}

/** A world-space vector (a pointer delta, not a point -- no translation)
 * turned into the box's own unrotated axes. What a resize drag must use
 * instead of the raw pointer delta once the box is turned: the box's
 * edges are no longer the world's x and y. */
export function toLocalVector(dx: number, dy: number, fr: Frame): Point {
  if (!fr.rotated) return [dx, dy];
  return [dx * fr.cos + dy * fr.sin, -dx * fr.sin + dy * fr.cos];
}

/** Where one of a box's corners or edge-midpoints sits on the page:
 * `sx`/`sy` of -1/0/1 pick west/centre/east and north/centre/south in the
 * box's own frame. `(±1, ±1)` is a corner, `(0, ±1)` or `(±1, 0)` the
 * midpoint of a wall. What a resize holds fixed while the opposite side
 * is dragged. */
export function anchorPoint(b: Box, sx: -1 | 0 | 1, sy: -1 | 0 | 1): Point {
  const local: Point = [b.left + b.width / 2 + sx * (b.width / 2), b.top + b.height / 2 + sy * (b.height / 2)];
  return localToPagePoly([local], frameOf(b))[0];
}

/** `b` resized to `width` x `height`, with the corner or wall-midpoint at
 * `(sx, sy)` (see `anchorPoint`) held exactly at `anchor` on the page.
 * This is the rotated generalisation of "drag a corner, the opposite one
 * doesn't move" / "drag a wall, the opposite wall doesn't move": solving
 * for the new centre from the fixed point, rather than carrying `left`
 * and `top` forward and rotating around whatever centre they land on,
 * is what keeps that point from drifting once the box is turned. */
export function resizedFromAnchor(b: Box, anchor: Point, sx: -1 | 0 | 1, sy: -1 | 0 | 1, width: number, height: number): Box {
  const rad = (b.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = width / 2;
  const hh = height / 2;
  const cx = anchor[0] - sx * hw * cos + sy * hh * sin;
  const cy = anchor[1] - sx * hw * sin - sy * hh * cos;
  return { ...b, width, height, left: cx - hw, top: cy - hh };
}

/** The four full-height / full-width strips left either side of a bite:
 * a lower bound on the largest rectangle that still fits. Erring low means
 * a carve is occasionally refused that would have been fine, never allowed
 * when it wouldn't. */
export function largestFreeStrip(rect: Rect, bite: BBox): { w: number; h: number }[] {
  const x1 = rect.left + rect.width;
  const y1 = rect.top + rect.height;
  return [
    { w: Math.max(0, bite.minX - rect.left), h: rect.height },
    { w: Math.max(0, x1 - bite.maxX), h: rect.height },
    { w: rect.width, h: Math.max(0, bite.minY - rect.top) },
    { w: rect.width, h: Math.max(0, y1 - bite.maxY) },
  ];
}


/**
 * Boolean polygon arithmetic, all of it through polygon-clipping (MIT).
 * Rings are plain [x, y] arrays; the library takes/returns GeoJSON-ish
 * nesting -- a Polygon is [outerRing, ...holes], a MultiPolygon a list of
 * those -- with rings explicitly closed, which ringToPoly strips back off.
 */
import polygonClipping from "polygon-clipping";

import type { Box, Frame, Point, Poly, Rect } from "./types";
import { cornersOfObb, obbOf } from "./rect";

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

/** Subtract `clippers` from `subject`. Null when the result is anything a
 * single polygon can't draw -- more than one piece, or a piece with a
 * hole -- which is also what keeps a room from being cut in two. */
export function subtractPolys(subject: Poly, clippers: Poly[]): Poly | null {
  if (!clippers.length) return subject;
  let out;
  try {
    out = polygonClipping.difference(polyToGeom(subject), ...clippers.map(polyToGeom));
  } catch {
    return null;
  }
  if (!out || out.length !== 1) return null;
  if (out[0].length !== 1) return null;
  const ring = ringToPoly(out[0][0]);
  return ring.length >= 3 ? ring : null;
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

export function intersectionArea(a: Poly, b: Poly): number {
  let out;
  try {
    out = polygonClipping.intersection(polyToGeom(a), polyToGeom(b));
  } catch {
    return 0;
  }
  let total = 0;
  for (const poly of out ?? []) {
    poly.forEach((ring, idx) => {
      const area = polyArea(ringToPoly(ring));
      total += idx === 0 ? area : -area;
    });
  }
  return total;
}

export function intersectionPoly(a: Poly, b: Poly): Poly | null {
  try {
    const out = polygonClipping.intersection(polyToGeom(a), polyToGeom(b));
    if (out && out.length && out[0].length) return ringToPoly(out[0][0]);
  } catch {
    /* fall through */
  }
  return null;
}

export interface BBox {
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

export function polyOfBox(b: Box): Poly {
  return cornersOfObb(obbOf(b));
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

export function samePolygon(a: Poly, b: Poly, tol = 0.002): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i][0] - b[i][0]) > tol || Math.abs(a[i][1] - b[i][1]) > tol) return false;
  }
  return true;
}

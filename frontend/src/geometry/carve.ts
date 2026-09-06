/**
 * Carving, on request only.
 *
 * Rooms overlap freely and nothing is ever pushed. The earlier rules --
 * carve first, protect the minimum, push last -- decided for you which
 * room gave way and moved rooms you had not touched, which made the
 * canvas unpredictable. Now a cut is something you ask for: select a
 * zone and press Carve, and it cuts every room it sits over. The victims
 * remember who cut them (`Box.carvedBy`), and the cut is recomputed from
 * the carver's current shape, so moving the carver moves the cut and
 * moving it away gives the space back. Release undoes it.
 *
 * The minimum is not enforced, it is reported: a room cut below its
 * type's minimum size, or cut in two, keeps the cut and is flagged so
 * the person can decide what to do about it.
 */
import polygonClipping from "polygon-clipping";

import {
  bboxOf,
  frameOf,
  largestFreeStrip,
  localToPagePoly,
  pageToLocalPoly,
  polyArea,
  polyOfBox,
  polyToGeom,
  rectPolyOf,
  ringToPoly,
} from "./poly";
import { boxesTrulyIntersect, rectOf } from "./rect";
import type { Box, Poly } from "./types";

/** Where the material is missing from `poly` relative to its own bounding
 * rectangle -- what was bitten out of it. */
function bboxOfCutAgainst(rect: { left: number; top: number; width: number; height: number }, poly: Poly) {
  const full = rectPolyOf(rect);
  let missing: Poly | null = null;
  try {
    const out = polygonClipping.difference(polyToGeom(full), polyToGeom(poly));
    missing = out && out.length && out[0].length ? ringToPoly(out[0][0]) : null;
  } catch {
    missing = null;
  }
  return missing ? bboxOf(missing) : { minX: rect.left, minY: rect.top, maxX: rect.left, maxY: rect.top };
}

/** Half a centimetre. The polygon booleans land a vertex a hair either
 * side of where a wall really is, and a room that is 2.9999 m wide against
 * a 3.0 m minimum is not a room below its minimum. */
const TOL = 0.005;

/** Is what's left of the box still a room? Minimum area, and still able to
 * hold its minimum rectangle. Its shape is deliberately unjudged. */
export function shapeStillUsable(b: Box, poly: Poly): boolean {
  if (polyArea(poly) < b.minWidth * b.minHeight - TOL) return false;
  const box = bboxOf(poly);
  const rect = { left: box.minX, top: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY };
  if (rect.width < b.minWidth - TOL || rect.height < b.minHeight - TOL) return false;
  const cutBox = bboxOfCutAgainst(rect, poly);
  return largestFreeStrip(rect, cutBox).some(
    (s) => s.w >= b.minWidth - TOL && s.h >= b.minHeight - TOL,
  );
}

/** `subject` minus every clipper. When the cut leaves several pieces the
 * largest is kept and `split` says so; a hole in the middle is filled
 * (only the outer ring is kept), which is the honest drawing of a room
 * with a column of someone else's space in it. */
export function subtractKeepLargest(subject: Poly, clippers: Poly[]): { poly: Poly; split: boolean } {
  if (!clippers.length) return { poly: subject, split: false };
  let out;
  try {
    out = polygonClipping.difference(polyToGeom(subject), ...clippers.map(polyToGeom));
  } catch {
    return { poly: subject, split: false };
  }
  if (!out || !out.length) return { poly: [], split: false };
  let best: Poly = [];
  let bestArea = -1;
  for (const piece of out) {
    const ring = ringToPoly(piece[0]);
    const area = polyArea(ring);
    if (area > bestArea) {
      best = ring;
      bestArea = area;
    }
  }
  return { poly: best, split: out.length > 1 };
}

export interface DisplayShape {
  id: string;
  /** In the box's own frame (what a rotated element's clip is drawn in). */
  local: Poly;
  /** In the plan frame (what the footprint union and the schedule read). */
  page: Poly;
  /** Something has actually been taken out of it. */
  carved: boolean;
  /** Cut below its minimum, or cut in two: needs the person's attention. */
  flagged: boolean;
}

/** Every live box's display polygon: its rectangle minus whatever the
 * rooms in its `carvedBy` list currently cover, and nothing more. */
export function displayShapes(live: Box[]): DisplayShape[] {
  const byId = new Map(live.map((b) => [b.id, b]));
  return live.map((el) => {
    const fr = frameOf(el);
    const base = rectPolyOf(rectOf(el));
    const clippers: Poly[] = [];
    for (const id of el.carvedBy) {
      const carver = byId.get(id);
      if (!carver || carver.id === el.id) continue;
      if (!boxesTrulyIntersect(el, carver)) continue;
      clippers.push(pageToLocalPoly(polyOfBox(carver), fr));
    }
    if (!clippers.length) {
      return { id: el.id, local: base, page: localToPagePoly(base, fr), carved: false, flagged: false };
    }
    const { poly, split } = subtractKeepLargest(base, clippers);
    if (poly.length < 3) {
      // Entirely covered. Draw the rectangle so it can still be grabbed,
      // and flag it: there is no room left.
      return { id: el.id, local: base, page: localToPagePoly(base, fr), carved: true, flagged: true };
    }
    const carved = polyArea(poly) < polyArea(base) - 1e-6;
    return {
      id: el.id,
      local: poly,
      page: localToPagePoly(poly, fr),
      carved,
      flagged: carved && (split || !shapeStillUsable(el, poly)),
    };
  });
}

/** `carver` cuts every live box it sits over. It is put on top: anything
 * it carves stops carving it. Returns the level's boxes, new objects only
 * where something changed. */
export function carveWith(carver: Box, live: Box[]): Box[] {
  const victims = new Set(
    live.filter((b) => b.id !== carver.id && boxesTrulyIntersect(b, carver)).map((b) => b.id),
  );
  if (!victims.size) return live;
  return live.map((b) => {
    if (b.id === carver.id) {
      const kept = b.carvedBy.filter((id) => !victims.has(id));
      return kept.length === b.carvedBy.length ? b : { ...b, carvedBy: kept };
    }
    if (!victims.has(b.id) || b.carvedBy.includes(carver.id)) return b;
    return { ...b, carvedBy: [...b.carvedBy, carver.id] };
  });
}

/** `carver` stops cutting anything. */
export function releaseCarve(carverId: string, live: Box[]): Box[] {
  return live.map((b) =>
    b.carvedBy.includes(carverId) ? { ...b, carvedBy: b.carvedBy.filter((id) => id !== carverId) } : b,
  );
}

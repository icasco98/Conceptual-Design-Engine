/**
 * What happens when two boxes overlap. Three rules, in order, nothing else:
 *
 *   CARVE FIRST. The box under the cursor keeps exactly the position the
 *   cursor gives it and takes the space it needs; whatever it overlaps
 *   gives up that space and draws itself around it.
 *
 *   PROTECT THE MINIMUM. No room is carved below its minimum area or below
 *   the minimum rectangle it must hold -- tested against the sum of every
 *   cut it is taking at once (carvePlanFor), because three cuts can each
 *   look harmless alone and gut the room together.
 *
 *   PUSH AS A LAST RESORT (resolve.ts). Only where a room cannot give the
 *   space up does anything move, and then it is the other room, one step,
 *   once.
 *
 * Corridors run the other way round: circulation is the one space whose
 * whole job is to stay open, so a room dragged onto a hallway bends around
 * it rather than eating it.
 */
import {
  bboxOf,
  frameOf,
  intersectionArea,
  intersectionPoly,
  largestFreeStrip,
  localToPagePoly,
  pageToLocalPoly,
  polyArea,
  polyOfBox,
  rectPolyOf,
  subtractPolys,
  polyToGeom,
  ringToPoly,
} from "./poly";
import polygonClipping from "polygon-clipping";
import { boxesTrulyIntersect, rectOf } from "./rect";
import { BITE_MAX_FRACTION, type Box, type Poly } from "./types";

/** Floor area above the box's own minimum: how much it has to give. */
export function slackOf(b: Box): number {
  return b.width * b.height - b.minWidth * b.minHeight;
}

/** Which of the pair SHOULD give way, before asking whether it can. */
export function biteVictim(a: Box, b: Box, pinnedId: string | null): Box {
  const aCorridor = a.kind === "corridor";
  const bCorridor = b.kind === "corridor";
  if (aCorridor !== bCorridor) return aCorridor ? b : a;
  if (pinnedId === a.id) return b;
  if (pinnedId === b.id) return a;
  return slackOf(a) >= slackOf(b) ? a : b;
}

function geomKey(b: Box): string {
  return `${b.id}|${b.left}|${b.top}|${b.width}|${b.height}|${b.rotation}`;
}

/** One resolve cycle's memo. canAbsorbBite runs a real polygon difference
 * and the resolver asks it about every overlapping pair on every pass. */
export class CarveContext {
  private memo = new Map<string, boolean>();
  constructor(public readonly pinnedId: string | null) {}

  canAbsorbBite(victim: Box, biter: Box): boolean {
    if (victim.id === biter.id) return false;
    const key = geomKey(victim) + ">" + geomKey(biter);
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    const result = computeCanAbsorbBite(victim, biter);
    this.memo.set(key, result);
    return result;
  }

  /** Of an overlapping pair, the one that will actually give up the
   * overlap: the preferred victim if it can absorb the cut, else the other
   * one, else nobody (null) and the pair has to be pushed apart. Never
   * falls back onto circulation. */
  chooseBiteVictim(a: Box, b: Box): Box | null {
    const first = biteVictim(a, b, this.pinnedId);
    const second = first.id === a.id ? b : a;
    if (this.canAbsorbBite(first, second)) return first;
    if (second.kind === "corridor") return null;
    if (this.canAbsorbBite(second, first)) return second;
    return null;
  }
}

function computeCanAbsorbBite(victim: Box, biter: Box): boolean {
  const fr = frameOf(victim);
  const rect = rectOf(victim);
  const base = rectPolyOf(rect);
  const clipperLocal = pageToLocalPoly(polyOfBox(biter), fr);
  const cut = subtractPolys(base, [clipperLocal]);
  if (!cut) return false;

  const full = rect.width * rect.height;
  const left = polyArea(cut);
  if (full <= 0) return false;
  if ((full - left) / full > BITE_MAX_FRACTION) return false;
  if (left < victim.minWidth * victim.minHeight - 1e-9) return false;

  // Measure the strips against the part of the biter that actually lands
  // ON this room, not the biter's whole bounding box.
  const overlapRegion = intersectionPoly(base, clipperLocal);
  const bite = bboxOf(overlapRegion ?? clipperLocal);
  return largestFreeStrip(rect, bite).some(
    (s) => s.w >= victim.minWidth - 1e-9 && s.h >= victim.minHeight - 1e-9,
  );
}

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

/** Is what's left of the box still a room? Minimum area, and still able to
 * hold its minimum rectangle. Its shape is deliberately unjudged. */
export function shapeStillUsable(b: Box, poly: Poly): boolean {
  if (polyArea(poly) < b.minWidth * b.minHeight - 1e-9) return false;
  const box = bboxOf(poly);
  const rect = { left: box.minX, top: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY };
  if (rect.width < b.minWidth - 1e-9 || rect.height < b.minHeight - 1e-9) return false;
  const cutBox = bboxOfCutAgainst(rect, poly);
  return largestFreeStrip(rect, cutBox).some(
    (s) => s.w >= b.minWidth - 1e-9 && s.h >= b.minHeight - 1e-9,
  );
}

export interface CarvePlan {
  /** The box's display polygon in its OWN frame. */
  poly: Poly;
  taking: Box[];
  refused: Box[];
}

/** Everything `el` is giving way to, and the shape that leaves it. The
 * single source of truth for both questions the canvas asks -- what to
 * draw, and whether anything must move. */
export function carvePlanFor(el: Box, live: Box[], ctx: CarveContext): CarvePlan {
  const fr = frameOf(el);
  const base = rectPolyOf(rectOf(el));
  const candidates: { el: Box; clipper: Poly }[] = [];
  for (const o of live) {
    if (o.id === el.id) continue;
    if (!boxesTrulyIntersect(el, o)) continue;
    if (biteVictim(el, o, ctx.pinnedId).id !== el.id) continue;
    candidates.push({ el: o, clipper: pageToLocalPoly(polyOfBox(o), fr) });
  }
  if (!candidates.length) return { poly: base, taking: [], refused: [] };

  // Deepest cut first, so when the room cannot take them all it is the
  // biggest intrusion that gets refused and pushed away instead.
  candidates.sort((a, b) => intersectionArea(base, b.clipper) - intersectionArea(base, a.clipper));

  let poly = base;
  const taking: Box[] = [];
  const refused: Box[] = [];
  for (const c of candidates) {
    const cut = subtractPolys(poly, [c.clipper]);
    if (cut && shapeStillUsable(el, cut)) {
      poly = cut;
      taking.push(c.el);
    } else {
      refused.push(c.el);
    }
  }
  return { poly, taking, refused };
}

export interface DisplayShape {
  id: string;
  /** In the box's own frame (what a rotated element's clip is drawn in). */
  local: Poly;
  /** In the plan frame (what the footprint union and the schedule read). */
  page: Poly;
  carved: boolean;
}

/** Every live box's display polygon: its rectangle minus whatever is
 * carved out of it, and never anything more. A conservative tidy-up pass
 * against shapes already settled removes only the overlap itself. */
export function displayShapes(live: Box[], pinnedId: string | null): DisplayShape[] {
  const ctx = new CarveContext(pinnedId);
  const settled: Poly[] = [];
  const settledBoxes: Box[] = [];
  const out: DisplayShape[] = [];
  for (const el of live) {
    const fr = frameOf(el);
    let localPoly = carvePlanFor(el, live, ctx).poly;
    let pagePoly = localToPagePoly(localPoly, fr);
    for (let s = 0; s < settled.length; s++) {
      if (ctx.chooseBiteVictim(el, settledBoxes[s])?.id !== el.id) continue;
      const overlap = intersectionArea(pagePoly, settled[s]);
      if (overlap <= 0.0015) continue;
      const trimmed = subtractPolys(pagePoly, [settled[s]]);
      if (!trimmed || trimmed.length < 3) continue;
      const removed = polyArea(pagePoly) - polyArea(trimmed);
      if (removed > overlap + 0.0015) continue;
      pagePoly = trimmed;
    }
    localPoly = pageToLocalPoly(pagePoly, fr);
    settled.push(pagePoly);
    settledBoxes.push(el);
    const rectPoly = rectPolyOf(rectOf(el));
    const carved = !(localPoly.length === 4 && sameCorners(localPoly, rectPoly));
    out.push({ id: el.id, local: localPoly, page: pagePoly, carved });
  }
  return out;
}

function sameCorners(a: Poly, b: Poly): boolean {
  return a.every((p) => b.some((q) => Math.abs(p[0] - q[0]) < 0.002 && Math.abs(p[1] - q[1]) < 0.002));
}

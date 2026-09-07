/**
 * The plot: the site boundary, and the wall the zones cannot cross.
 *
 * The sheet has always been decoration -- a faint rectangle to draw on,
 * with nothing stopping a zone being drawn off it. The plot is the same
 * rectangle made real: switch it on and it becomes a hard edge that every
 * gesture is held inside.
 *
 * Three rules hold everything here together, and they are the reason the
 * functions are shaped the way they are:
 *
 * 1. **The wall is felt while you drag, not reported afterwards.** Every
 *    gesture in the canvas ends by asking this module for the correction,
 *    so a zone stops against the boundary the way a box stops against a
 *    skirting board. Nothing is ever placed badly and then complained
 *    about.
 *
 * 2. **A selection is clamped as one rigid body**, never zone by zone.
 *    Clamping each zone separately would let them hit the wall at
 *    different moments and drift apart, quietly deforming an arrangement
 *    the person spent time on. `shiftGroupInside` takes the whole
 *    selection's outline and returns one shift for all of them.
 *
 * 3. **What cannot fit is flagged, never forced.** A zone wider than the
 *    plot, or one already outside when the boundary was switched on, is
 *    left exactly where it is and marked (`isOutsidePlot`). The tool's
 *    standing promise is that it never moves a zone the person is not
 *    holding, and a boundary is not a reason to break it.
 *
 * Everything works on a zone's *turned* outline (`polyOfBox`), not on its
 * axis-aligned rectangle. Rotation here is free, and a 4 x 6 m room at 45
 * degrees needs 7.1 m of width: a rectangle test would let a corner
 * through the wall.
 */
import { bboxOf, polyOfBox } from "./poly";
import { type Box, type Plot, type Point, type Poly } from "./types";

/** A millimetre. Floating point puts an edge a hair either side of the
 * boundary; a zone 0.0001 m over the line is on the line. */
const EPS = 1e-3;

export function plotRight(plot: Plot): number {
  return plot.left + plot.width;
}

export function plotBottom(plot: Plot): number {
  return plot.top + plot.depth;
}

/** Every corner of every named zone, as one point cloud. Only the extent
 * is ever wanted, so there is no need to union the outlines properly. */
function cornersOf(boxes: Box[], ids: Set<string>): Poly {
  const out: Poly = [];
  for (const b of boxes) {
    if (!ids.has(b.id) || b.deleted) continue;
    for (const p of polyOfBox(b)) out.push(p);
  }
  return out;
}

/**
 * The smallest shift that brings `poly` back inside `plot`, `[0, 0]` when
 * it is already in.
 *
 * An axis whose extent is larger than the plot's is left alone rather
 * than pinned to one side: a zone too big to fit cannot be trapped, and
 * a tool that kept yanking it against a wall it can never satisfy would
 * just be fighting the person. It is flagged instead.
 */
export function shiftInside(poly: Poly, plot: Plot): Point {
  if (!poly.length) return [0, 0];
  const b = bboxOf(poly);
  let dx = 0;
  let dy = 0;
  if (b.maxX - b.minX <= plot.width + EPS) {
    if (b.minX < plot.left - EPS) dx = plot.left - b.minX;
    else if (b.maxX > plotRight(plot) + EPS) dx = plotRight(plot) - b.maxX;
  }
  if (b.maxY - b.minY <= plot.depth + EPS) {
    if (b.minY < plot.top - EPS) dy = plot.top - b.minY;
    else if (b.maxY > plotBottom(plot) + EPS) dy = plotBottom(plot) - b.maxY;
  }
  return [dx, dy];
}

/** The one shift that brings a whole selection back inside -- see rule 2
 * at the top of this file. */
export function shiftGroupInside(boxes: Box[], ids: Iterable<string>, plot: Plot): Point {
  if (!plot.on) return [0, 0];
  return shiftInside(cornersOf(boxes, new Set(ids)), plot);
}

/** `boxes`, with every zone in `ids` moved by that one shift. The zones
 * outside the selection are returned untouched, and so are their objects,
 * so React re-renders only what actually moved. */
export function clampGroup(boxes: Box[], ids: Iterable<string>, plot: Plot): Box[] {
  const set = new Set(ids);
  const [dx, dy] = shiftGroupInside(boxes, set, plot);
  if (!dx && !dy) return boxes;
  return boxes.map((b) => (set.has(b.id) ? { ...b, left: b.left + dx, top: b.top + dy } : b));
}

/** Does the zone's turned outline leave the plot? False when the plot is
 * off: there is no boundary to be outside of. */
export function isOutsidePlot(b: Box, plot: Plot): boolean {
  if (!plot.on || b.deleted) return false;
  const bb = bboxOf(polyOfBox(b));
  return (
    bb.minX < plot.left - EPS ||
    bb.minY < plot.top - EPS ||
    bb.maxX > plotRight(plot) + EPS ||
    bb.maxY > plotBottom(plot) + EPS
  );
}

/** Fully within the boundary. */
function fitsInside(poly: Poly, plot: Plot): boolean {
  const bb = bboxOf(poly);
  return (
    bb.minX >= plot.left - EPS &&
    bb.minY >= plot.top - EPS &&
    bb.maxX <= plotRight(plot) + EPS &&
    bb.maxY <= plotBottom(plot) + EPS
  );
}

/** Small enough to fit somewhere in the plot, wherever it currently sits.
 * The test a resize wants when the zone is allowed to slide in
 * afterwards. */
function fitsExtent(poly: Poly, plot: Plot): boolean {
  const bb = bboxOf(poly);
  return bb.maxX - bb.minX <= plot.width + EPS && bb.maxY - bb.minY <= plot.depth + EPS;
}

/** How far between `from` and `to` a resize may go. */
export type GrowthTest =
  /** The zone must end up inside the plot where it stands: the resize
   * gesture, where the corner you are not dragging must not move. */
  | "inside"
  /** The zone need only be small enough to fit: a size typed into the
   * schedule, which is capped and then slid in. */
  | "extent";

/**
 * The furthest a zone may be resized from `from` towards `to` without
 * breaking `test`.
 *
 * The four numbers a resize changes -- left, top, width, height -- are
 * interpolated together, so the outline is an affine function of the
 * fraction travelled and the overhang past a wall grows monotonically
 * with it. That makes plain bisection both correct and quick: twenty
 * halvings put the edge within a hundredth of a millimetre of the wall,
 * on a rectangle or on a circle's 48-gon alike.
 *
 * A zone that was *already* outside before the edit is returned
 * untouched. Rule 3: it was not put there by this gesture, and taking it
 * over now would move a zone the person did not ask to move.
 */
export function limitGrowth(from: Box, to: Box, plot: Plot, test: GrowthTest = "inside"): Box {
  if (!plot.on) return to;
  const ok = (b: Box) => (test === "inside" ? fitsInside(polyOfBox(b), plot) : fitsExtent(polyOfBox(b), plot));
  if (ok(to)) return to;
  if (!ok(from)) return to;
  const at = (s: number): Box => ({
    ...to,
    left: from.left + (to.left - from.left) * s,
    top: from.top + (to.top - from.top) * s,
    width: from.width + (to.width - from.width) * s,
    height: from.height + (to.height - from.height) * s,
  });
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (ok(at(mid))) lo = mid;
    else hi = mid;
  }
  return at(lo);
}

/**
 * A zone edited by hand rather than dragged -- a width, a depth or a
 * rotation typed into the schedule -- brought back inside the plot.
 *
 * The schedule has to obey the same wall as the canvas, or it is a back
 * door around the boundary: type 40 m into a 20 m plot and the zone would
 * simply be outside. So the new size is capped at what the plot can hold,
 * and then the zone slides in far enough to sit within it -- the same
 * "slide it back in" that a rotation gets on the canvas.
 */
export function settleInPlot(from: Box, to: Box, plot: Plot): Box {
  if (!plot.on || isOutsidePlot(from, plot)) return to;
  const capped = limitGrowth(from, to, plot, "extent");
  const [dx, dy] = shiftInside(polyOfBox(capped), plot);
  return dx || dy ? { ...capped, left: capped.left + dx, top: capped.top + dy } : capped;
}

/** A rectangle being drawn, held inside the plot. No rotation is involved
 * yet, so the rubber band is simply cut back to the boundary. */
export function clampDrawnRect(
  r: { left: number; top: number; width: number; height: number },
  plot: Plot,
): { left: number; top: number; width: number; height: number } {
  if (!plot.on) return r;
  const left = Math.min(Math.max(r.left, plot.left), plotRight(plot));
  const top = Math.min(Math.max(r.top, plot.top), plotBottom(plot));
  return {
    left,
    top,
    width: Math.max(0, Math.min(r.left + r.width, plotRight(plot)) - left),
    height: Math.max(0, Math.min(r.top + r.height, plotBottom(plot)) - top),
  };
}

/** The zones that are outside the boundary, in drawing order. The status
 * bar names them; the plan outlines them. */
export function outsidePlot(boxes: Box[], plot: Plot): Box[] {
  return plot.on ? boxes.filter((b) => isOutsidePlot(b, plot)) : [];
}

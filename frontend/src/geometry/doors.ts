/**
 * Shared walls between two zones' actual outlines -- rotated, polygon or
 * carved-flat alike -- the one primitive `suggestArrows` (arrows.ts) and
 * the circulation graph (circulation.ts) both build on, so "touching" is
 * decided in one place.
 *
 * Each zone's outline is supplied by the caller as its outline on the
 * page: ordinarily a plain rectangle, but a rotated box arrives already
 * turned, a hand-drawn polygon as its own vertices, and a zone with a
 * carve taken out of it (carve.ts's `displayShapes`) with the cut
 * boundary as one of its edges. That last case is what lets a
 * carved-into zone and the zone that carved it show up as touching with
 * no special-case carve logic here at all: subtracting one polygon from
 * another leaves the two outlines sharing exactly the cut's own edge,
 * and an edge is an edge -- the same test that finds a plain shared wall
 * finds this one too.
 */
import type { Point, Poly } from "./types";

export interface Touch {
  /** The overlapping wall run, in page-frame meters, one endpoint to the
   * other -- what a placed door's own position is checked against. */
  p1: Point;
  p2: Point;
}

export function touchMid(t: Touch): Point {
  return [(t.p1[0] + t.p2[0]) / 2, (t.p1[1] + t.p2[1]) / 2];
}

/** Every run along which an edge of `pa` and an edge of `pb` sit on the
 * same line and overlap in extent -- one `Touch` per stretch of shared
 * wall. Usually one, but a carve can leave two zones sharing more than
 * one separate run, so every run is returned rather than just the
 * first. Winding direction does not matter, and neither does which
 * polygon's edge is "first": this only asks whether the two lines
 * coincide, close enough (`tol`) and for long enough to be a real wall
 * rather than two corners glancing past each other. */
export function touchingEdges(pa: Poly, pb: Poly, tol: number): Touch[] {
  const out: Touch[] = [];
  for (let i = 0; i < pa.length; i++) {
    const a1 = pa[i];
    const a2 = pa[(i + 1) % pa.length];
    const dx = a2[0] - a1[0];
    const dy = a2[1] - a1[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const ux = dx / len;
    const uy = dy / len;
    for (let j = 0; j < pb.length; j++) {
      const b1 = pb[j];
      const b2 = pb[(j + 1) % pb.length];
      // Both endpoints of b's edge must sit on a's line within tol --
      // the perpendicular distance from the line through a1/a2.
      const perp1 = (b1[0] - a1[0]) * uy - (b1[1] - a1[1]) * ux;
      const perp2 = (b2[0] - a1[0]) * uy - (b2[1] - a1[1]) * ux;
      if (Math.abs(perp1) > tol || Math.abs(perp2) > tol) continue;
      const along = (p: Point) => (p[0] - a1[0]) * ux + (p[1] - a1[1]) * uy;
      const lo = Math.max(0, Math.min(along(b1), along(b2)));
      const hi = Math.min(len, Math.max(along(b1), along(b2)));
      if (hi - lo < tol) continue;
      out.push({ p1: [a1[0] + ux * lo, a1[1] + uy * lo], p2: [a1[0] + ux * hi, a1[1] + uy * hi] });
    }
  }
  return out;
}

export interface TouchGraphEdge {
  to: string;
  touch: Touch;
}

/** Every pair of zones in `polyById` that share a wall, both directions,
 * one entry per shared run. `polyById` is each zone's actual outline on
 * the page right now -- a caller that cares about carving passes
 * `displayShapes`'s post-carve polygons, and two zones that simply sit
 * side by side, uncarved, read exactly as they always did. */
export function buildTouchGraph(polyById: Map<string, Poly>, tol: number): Map<string, TouchGraphEdge[]> {
  const graph = new Map<string, TouchGraphEdge[]>();
  const ids = [...polyById.keys()];
  const push = (from: string, to: string, touch: Touch) => {
    const list = graph.get(from) ?? [];
    list.push({ to, touch });
    graph.set(from, list);
  };
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const touches = touchingEdges(polyById.get(ids[i])!, polyById.get(ids[j])!, tol);
      for (const touch of touches) {
        push(ids[i], ids[j], touch);
        push(ids[j], ids[i], touch);
      }
    }
  }
  return graph;
}

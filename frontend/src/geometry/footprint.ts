/**
 * The building outline: the union of every box's display polygon, so it
 * follows a rotated room's real diagonal walls and a carved room's notch.
 */
import { displayShapesForLevelMemo } from "./memo";
import { polyArea, unionPolys } from "./poly";
import type { Box, Plot, Poly } from "./types";

/** Rings (outer first, holes after) of every piece of the outline. */
export function footprintRings(displayPolys: Poly[]): Poly[] {
  const out: Poly[] = [];
  for (const piece of unionPolys(displayPolys)) {
    for (const ring of piece) if (ring.length >= 3) out.push(ring);
  }
  return out;
}

/** How much of the plot one storey's footprint actually uses, 0..1 --
 * the sum of that storey's own room areas (post-carve, `displayShapes`)
 * over the plot's area. Summing each room rather than unioning the whole
 * footprint is exactly equivalent here and cheaper: `displayShapes`
 * already guarantees every room on a storey is disjoint from every other
 * (that is what carving is for), and the area of a union of disjoint
 * polygons is just the sum of their own areas.
 *
 * `0` when the plot has no area (off, or zero-sized) -- there is no
 * meaningful ratio to report, not a divide-by-zero to hide. The one
 * shared implementation `StatusBar.tsx`'s own coverage line and
 * `geometry/generate.ts`'s reported (not search-driving, see its own
 * doc comment) coverage number both read, instead of two copies of the
 * same sum that could drift apart. */
export function footprintCoverage(boxes: Box[], level: number, autoCarve: boolean, plot: Plot): number {
  const plotArea = plot.width * plot.depth;
  if (plotArea <= 0) return 0;
  const shapes = displayShapesForLevelMemo(boxes, level, autoCarve);
  const total = shapes.reduce((sum, s) => sum + polyArea(s.page), 0);
  return total / plotArea;
}

export function ringsToPath(rings: Poly[]): string {
  return rings
    .map((ring) => "M " + ring.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(" L ") + " Z")
    .join(" ");
}

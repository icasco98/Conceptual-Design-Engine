/**
 * The building outline: the union of every box's display polygon, so it
 * follows a rotated room's real diagonal walls and a carved room's notch.
 */
import { unionPolys } from "./poly";
import type { Poly } from "./types";

/** Rings (outer first, holes after) of every piece of the outline. */
export function footprintRings(displayPolys: Poly[]): Poly[] {
  const out: Poly[] = [];
  for (const piece of unionPolys(displayPolys)) {
    for (const ring of piece) if (ring.length >= 3) out.push(ring);
  }
  return out;
}

export function ringsToPath(rings: Poly[]): string {
  return rings
    .map((ring) => "M " + ring.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(" L ") + " Z")
    .join(" ");
}

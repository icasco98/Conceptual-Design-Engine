/**
 * Vertical circulation, collapsed.
 *
 * A stair is packed once and placed at identical coordinates on every level
 * it connects, so it reaches the canvas as one box per storey sharing a
 * name. That is right for the plan — each storey draws its own — and wrong
 * for the 3D, where drawing one box per storey stacks separate blocks where
 * a building has a single continuous shaft.
 *
 * This collapses those boxes back into the shaft they describe: one entry
 * per stair, carrying the storeys it spans.
 */
import { liveBoxes } from "./resolve";
import type { Box } from "./types";

export interface Shaft {
  /** Any one of the stair's boxes: they share position and size. */
  box: Box;
  /** Lowest and highest storey the shaft connects, inclusive. */
  from: number;
  to: number;
}

/** Every stair in `boxes`, as one shaft each, in the order first met. */
export function stairShafts(boxes: Box[], storeys: number): Shaft[] {
  const found = new Map<string, Shaft>();
  for (let lv = 0; lv < storeys; lv++) {
    for (const b of liveBoxes(boxes, lv)) {
      if (b.roomType !== "stair") continue;
      const seen = found.get(b.name);
      if (seen) {
        seen.from = Math.min(seen.from, lv);
        seen.to = Math.max(seen.to, lv);
      } else {
        found.set(b.name, { box: b, from: lv, to: lv });
      }
    }
  }
  return [...found.values()];
}

/** The shafts that pass *through* the floor plate of `level`, and so need a
 *  void cut in it. A shaft's own lowest floor is not pierced: it stands on
 *  it. */
export function shaftsPiercing(shafts: Shaft[], level: number): Shaft[] {
  return shafts.filter((s) => s.from < level && level <= s.to);
}

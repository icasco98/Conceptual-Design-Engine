/**
 * Vertical masses.
 *
 * A box that spans more than one storey (`levelTo > level`) -- a stair, a
 * double-height void -- is drawn on every plan it passes through but is
 * one thing in the building, so the 3D draws it once, floor of its lowest
 * storey to ceiling of its highest, and cuts every floor plate it passes
 * through around it.
 */
import type { Box } from "./types";

export interface Shaft {
  box: Box;
  /** Lowest and highest storey the shaft connects, inclusive. */
  from: number;
  to: number;
}

/** Every live box spanning more than one storey. */
export function stairShafts(boxes: Box[]): Shaft[] {
  return boxes.filter((b) => !b.deleted && b.levelTo > b.level).map((b) => ({ box: b, from: b.level, to: b.levelTo }));
}

/** The shafts that pass *through* the floor plate of `level`, and so need a
 *  void cut in it. A shaft's own lowest floor is not pierced: it stands on
 *  it. */
export function shaftsPiercing(shafts: Shaft[], level: number): Shaft[] {
  return shafts.filter((s) => s.from < level && level <= s.to);
}

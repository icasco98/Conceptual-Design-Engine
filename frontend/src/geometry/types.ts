/**
 * The canvas's own data model, in PLAN FRAME meters.
 *
 * Plan frame: x runs right, y runs DOWN the screen, origin at the top-left
 * of the sheet. The sheet itself is an unbounded drawing surface. The one
 * boundary that can exist is the plot (`Plot`, geometry/plot.ts), and only
 * while it is switched on; with it off a box may still sit anywhere.
 * Every module under geometry/ works in this frame and nothing else, and
 * because nothing outside the browser owns the arrangement any more there
 * is no second frame to convert to.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Point = [number, number];
export type Poly = Point[];

export type BoxKind = "room" | "corridor";

/** A rectangle, the ellipse inscribed in it, or a hand-drawn polygon.
 * Drawn as a circle it starts with width = height; the schedule can make
 * it an ellipse. */
export type BoxShape = "rect" | "circle" | "polygon";

export interface Box {
  /** Stable identity across edits. Not the display name. */
  id: string;
  name: string;
  kind: BoxKind;
  shape: BoxShape;
  roomType: string;
  isEntry: boolean;
  /** Lowest storey the box is on, 0 = ground. */
  level: number;
  /** Highest storey reached, inclusive. Derived from `heightM`: a zone
   * taller than a storey spans into the ones above, is drawn on each and
   * is one mass in 3D. Kept on the box so every reader need not know the
   * storey height. */
  levelTo: number;
  /** Vertical height, meters. Defaults to the storey height. */
  heightM: number;
  /** Which zone gives way where two overlap, when automatic carving is
   * on: 1 is the highest, and a higher priority carves a lower one. Equal
   * priorities never carve each other -- the tool is not guessing. */
  priority: number;
  left: number;
  top: number;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  /** Degrees, clockwise on screen. */
  rotation: number;
  /** Ids of the boxes that have been asked to carve this one. Their
   * current shape is cut out of it wherever they still overlap. */
  carvedBy: string[];
  deleted: boolean;
  /** Undefined and `true` both mean placed: a zone drawn or loaded is on
   * the plan. `false` is a zone added from the schedule with a name, type
   * and size but no position yet -- it exists in the schedule and in
   * undo history, but is invisible to the plan, the 3D view, carving and
   * the plot, exactly as if it did not exist there yet. Placing it flips
   * this and gives it a position, and it behaves like any other zone from
   * then on. */
  placed?: boolean;
  /** Where the sample put it, for Reset. */
  initial: Rect;
  /** A `"polygon"` box's own outline, one point per vertex, each as a
   * fraction (0..1) of the way across the bounding box (`left`/`top`/
   * `width`/`height`) -- the same box drawn by hand, whichever direction
   * it's dragged: a corner or wall resize scales every vertex with it,
   * exactly as it already scales a rectangle. Unused on any other shape. */
  points?: Point[];
}

/**
 * The site boundary. `on` is the checkbox: off, it is a faint rectangle
 * to draw against and nothing more (which is all the sheet ever was);
 * on, it is a hard wall no zone can be dragged, turned or resized
 * through. Rectangular for now -- an irregular lot is the same machinery
 * against sloped edges, and a later step.
 */
export interface Plot {
  on: boolean;
  left: number;
  top: number;
  width: number;
  depth: number;
}

/** Oriented bounding box: center, half extents, and its own unit axes. */
export interface Obb {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  ax: Point;
  ay: Point;
}

/** A box's own frame: the unrotated rectangle it occupies, with the world
 * turned around it. See carve.ts. */
export interface Frame {
  cx: number;
  cy: number;
  cos: number;
  sin: number;
  rotated: boolean;
}

/** Two shapes count as overlapping only past this much, in meters: a
 * shared edge and the rounding either side of it are not an overlap. */
export const OVERLAP_EPS = 0.002;
/** Every box's position snaps to this grid while dragging or resizing. */
export const GRID_M = 0.25;
/** A dragged box within this of a facing neighbour snaps to touch it. */
export const GAP_SNAP_M = 1.0;
/** Door arrow endpoints sit this far either side of the wall. */
export const DOOR_INSET_M = 0.35;
/** How many sides a circle is drawn and computed with. */
export const CIRCLE_SEGMENTS = 48;

/** A door arrow. It lives on one wall of its host zone, perpendicular to
 * it, and is stored in the host's own frame so it turns and moves with
 * the host.
 *
 * `interior` is a door between two zones (or into a carve), always aimed
 * at a target. `exterior-main` and `exterior-side` are doors through the
 * building's outer wall, aimed at nothing -- there is no zone beyond
 * them. Only one `exterior-main` stands at a time: placing one makes its
 * host `isEntry` and un-marks whichever zone had it before, since a
 * building has one front door. `exterior-side` is unlimited -- a garage,
 * deck or service door is still a door without being the entrance
 * `suggestArrows` starts its walk from. Missing `kind` (an arrow saved
 * before this existed) means `interior`. */
export interface Arrow {
  id: string;
  level: number;
  hostId: string;
  kind?: "interior" | "exterior-main" | "exterior-side";
  /** The zone it was suggested to lead into, if any; only used to avoid
   * suggesting a second arrow for the same zone. Exterior arrows never
   * have one -- they lead outside, not into another zone. */
  targetId?: string;
  /** 0 top, 1 right, 2 bottom, 3 left in the host's frame; unused on a circle. */
  side: number;
  /** How far along that wall, 0..1; on a circle, the fraction of a turn. */
  t: number;
  /** 1 = out of the host, -1 = into it. */
  dir: 1 | -1;
}

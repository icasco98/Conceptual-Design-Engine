/**
 * The canvas's own data model, in PLAN FRAME meters.
 *
 * Plan frame: x runs right, y runs DOWN the screen, origin at the top-left
 * of the sheet. There is no site and no setback line in this tool: the
 * sheet is an unbounded drawing surface and a box may sit anywhere on it.
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

/** A rectangle, or the ellipse inscribed in it. Drawn as a circle it
 * starts with width = height; the schedule can make it an ellipse. */
export type BoxShape = "rect" | "circle";

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
  /** Where the sample put it, for Reset. */
  initial: Rect;
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

/** Sub-meter overlaps don't count; see resolve.ts. 0.05px at the old
 * 26px/m scale. */
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
 * the host. */
export interface Arrow {
  id: string;
  level: number;
  hostId: string;
  /** The zone it was suggested to lead into, if any; only used to avoid
   * suggesting a second arrow for the same zone. */
  targetId?: string;
  /** 0 top, 1 right, 2 bottom, 3 left in the host's frame; unused on a circle. */
  side: number;
  /** How far along that wall, 0..1; on a circle, the fraction of a turn. */
  t: number;
  /** 1 = out of the host, -1 = into it. */
  dir: 1 | -1;
}

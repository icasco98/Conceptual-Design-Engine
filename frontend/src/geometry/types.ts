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
/** Who someone is, for the one thing circulation checks automatically:
 * whether the route stays where that role belongs (geometry/circulation.ts,
 * `outOfBounds`). Not the same axis as a zone's own category -- an owner
 * is `served` wherever they go, a caterer is `servant` even while
 * standing in the kitchen, which is `category_b`.
 *
 * `majlis_guest` is its own role rather than a stricter `guest`: a guest
 * the household has invited into its own life is welcome in the shared
 * rooms (`category_b`), while a majlis or diwaniya guest is received in
 * one room built for exactly that (`category_d`) and nowhere else in the
 * house -- the point of a Gulf household building that room with its own
 * street door in the first place. */
export type ActorRole = "served" | "guest" | "servant" | "exterior" | "majlis_guest";

/** Someone who walks through the building, and the rooms they visit, in
 * order. The walk between each pair of waypoints is never stored -- it is
 * the shortest crossing of the touching graph (geometry/circulation.ts),
 * recomputed from wherever the zones currently are, exactly as a door
 * arrow's suggestion is. Move a room and every actor's route follows it
 * without being told to. */
export interface Actor {
  id: string;
  name: string;
  role: ActorRole;
  /** Assigned once, at creation, from a fixed rotation -- never guessed
   * from the role, since two actors of the same role must still read as
   * two different lines on the plan. */
  color: string;
  /** Zone ids, in the order they are visited. A waypoint that no longer
   * exists (the zone was deleted) or that nothing can reach is simply
   * skipped when the route is drawn -- the rest of it still shows. */
  waypoints: string[];
  visible: boolean;
}

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
  /** Where this arrow was last drawn while it was still a real door --
   * `[tail, head]` in page-frame meters, kept in sync automatically for
   * as long as `hostId`/`side`/`t` resolve onto a real wall, and left
   * untouched the moment they stop to. Undefined only for an arrow that
   * has never once been live (a stale one loaded from a layout saved
   * before this field existed). Never read to decide whether a door is
   * real -- that is `arrowIsLive`'s question, answered fresh from
   * `hostId`/`side`/`t` every time -- only to decide where to draw one
   * that already failed it. */
  frozenAt?: [Point, Point];
}

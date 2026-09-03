/**
 * The canvas's own data model, in PLAN FRAME meters.
 *
 * Plan frame: x runs right, y runs DOWN the screen, origin at the site's
 * FRONT-left corner, so the street runs along the top of the drawing --
 * exactly how the diagram has always been drawn. Every module under
 * geometry/ works in this frame and nothing else; the conversion to the
 * site frame the Python backend uses (y up from the site's back edge, so
 * the front edge is at y = site depth) happens once, in api/convert.ts.
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

export interface Box {
  /** Stable identity across edits. Not the display name. */
  id: string;
  name: string;
  kind: BoxKind;
  roomType: string;
  isEntry: boolean;
  level: number;
  left: number;
  top: number;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  /** Degrees, clockwise on screen. */
  rotation: number;
  deleted: boolean;
  /** Where the recommendation put it, for Reset. */
  initial: Rect;
}

/** The buildable envelope (setback line) in plan frame meters. */
export interface Envelope {
  left: number;
  top: number;
  right: number;
  bottom: number;
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
/** The most of itself a room may give up to a bite. */
export const BITE_MAX_FRACTION = 0.45;

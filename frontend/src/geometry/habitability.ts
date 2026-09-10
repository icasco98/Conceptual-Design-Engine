/**
 * Whether a room can be lived in, as distinct from whether the plan works
 * (relationships.ts, circulation.ts) or what it costs (efficiency.ts).
 *
 * Code-derived, not a preference. Every sleeping room needs an emergency
 * escape and rescue opening directly to the outside -- a window or door
 * someone can get out of, and a firefighter can get in through (IRC R310
 * is the usual statement of it; the requirement is near-universal in
 * residential codes). A room with no exterior wall at all cannot have
 * one. A landlocked bedroom is not an expensive bedroom or an awkward
 * one; it is not a bedroom. That makes this a hard problem, the same
 * category as an unmet requirement.
 *
 * Deliberately narrowed to *sleeping* rooms, though the light-and-air
 * rule (IRC R303.1: glazing at 8% of floor area, openable at 4%) covers
 * every habitable room. The reason is that the wider rule has a real and
 * commonly used exception: an interior room may borrow its light and
 * ventilation from an adjoining room through a large enough opening
 * (R303.2), which is exactly how a dining room open to a living room is
 * normally justified -- and this tool has no way to tell a wide cased
 * opening from a solid wall, because it models doors and walls and
 * nothing in between. Applying the wider rule here would flag that
 * perfectly ordinary arrangement as a defect. The escape-opening rule
 * has no such exception: a bedroom cannot borrow an escape route from
 * the room next door.
 *
 * This lives in its own file rather than in efficiency.ts, which is
 * explicitly the "is this wasting money" axis and already carries one
 * reluctant exception (`deadEndHallways`); a second would stop that file
 * meaning anything.
 *
 * Scope, stated plainly: this measures *exterior wall*, not windows. The
 * tool has no window objects, and inventing them to check this would be
 * inventing the answer. What it can say for certain is that a room with
 * no wall facing outside can have no window at all, which is the case
 * worth catching at conceptual-design stage. A room with plenty of
 * exterior wall and no window drawn on it is a later question, and this
 * file deliberately does not pretend to answer it.
 *
 * Read-only, like every other check: it names a room, it never moves one.
 */
import { displayShapesForLevelMemo, levelTouchDataMemo } from "./memo";
import { liveBoxes } from "./snap";
import { unionLength } from "./efficiency";
import type { Box, Point, Poly } from "./types";

/** How much uninterrupted outside-facing wall a sleeping room needs
 * before this stops objecting. An escape opening is roughly 0.9 m across
 * at the narrowest (IRC R310 asks for 0.53 m² of clear opening, at least
 * 0.508 m wide and 0.61 m high, which no narrower wall can hold), and
 * the wall it sits in needs its own structure either side. Deliberately
 * generous: the point is to catch a room with effectively nothing facing
 * outside, not to adjudicate a tight one. */
export const MIN_EXTERIOR_WALL_M = 1.0;

/** Within this, a wall run and a room's own edge are the same line --
 * the same tolerance the touch graph itself was built with, so a run this
 * file measures against an edge is a run `buildTouchGraph` would have
 * agreed sits on it. */
const EDGE_TOL_M = 0.05;

export interface WindowlessFinding {
  roomId: string;
  /** How much of this room's own outline faces outside, meters -- 0 when
   * it is completely enclosed by neighbours. */
  exteriorM: number;
  level: number;
}

/**
 * How much of one room's outline is not covered by a neighbour, in
 * meters -- `exposedOnEdge` summed over every edge of the outline. See
 * that helper for why this is not `perimeter - sum(touches)`.
 *
 * Works on the room's real outline -- rotated, hand-drawn or post-carve
 * -- because it walks whatever polygon `displayShapes` produced, never a
 * rectangle's four nominal sides.
 */
export function exteriorWallLength(boxes: Box[], level: number, autoCarve: boolean, roomId: string): number {
  const live = liveBoxes(boxes, level);
  const index = live.findIndex((b) => b.id === roomId);
  if (index === -1) return 0;
  const poly = displayShapesForLevelMemo(boxes, level, autoCarve)[index].page;
  const { touchGraph } = levelTouchDataMemo(boxes, level, autoCarve);
  const runs = (touchGraph.get(roomId) ?? []).map((e) => e.touch);

  let exterior = 0;
  for (let i = 0; i < poly.length; i++) {
    exterior += exposedOnEdge(poly[i], poly[(i + 1) % poly.length], runs);
  }
  return exterior;
}

/** How much of the single edge `a`-`b` no neighbour covers, in meters.
 * The covered intervals are merged (`unionLength`) before subtracting,
 * which is the whole reason this is not simply `len - sum(runs)`: two
 * neighbours meeting the same stretch of wall -- routine once a carve is
 * involved, possible anywhere three rooms meet -- would otherwise be
 * subtracted twice and a room with daylight reported as sealed. */
function exposedOnEdge(a: Point, b: Point, runs: { p1: Point; p2: Point }[]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return 0;
  const ux = dx / len;
  const uy = dy / len;
  const along = (p: Point) => (p[0] - a[0]) * ux + (p[1] - a[1]) * uy;
  const across = (p: Point) => (p[0] - a[0]) * uy - (p[1] - a[1]) * ux;
  const covered: [number, number][] = [];
  for (const run of runs) {
    // Both ends of the run have to sit on this edge's own line, or the
    // run belongs to a different edge of the same room.
    if (Math.abs(across(run.p1)) > EDGE_TOL_M || Math.abs(across(run.p2)) > EDGE_TOL_M) continue;
    const lo = Math.max(0, Math.min(along(run.p1), along(run.p2)));
    const hi = Math.min(len, Math.max(along(run.p1), along(run.p2)));
    if (hi - lo > EDGE_TOL_M) covered.push([lo, hi]);
  }
  return Math.max(0, len - unionLength(covered));
}

/**
 * Every sleeping room with effectively no wall facing outside -- so no
 * window, and therefore no emergency escape and rescue opening. See the
 * file's own doc comment for the code this is drawn from, for why it
 * stops at sleeping rooms rather than every habitable one, and for what
 * it deliberately does not claim.
 *
 * `sleepingOf` is handed in rather than read from `rooms.ts`, the same
 * way every other room-type fact reaches this layer. A bathroom, closet,
 * garage, hallway or store room is legitimately internal and always has
 * been, which is why this cannot simply be run over every room.
 */
export function windowlessSleepingRooms(
  boxes: Box[],
  storeys: number,
  autoCarve: boolean,
  sleepingOf: (roomType: string) => boolean,
): WindowlessFinding[] {
  const out: WindowlessFinding[] = [];
  for (let level = 0; level < storeys; level++) {
    for (const room of liveBoxes(boxes, level)) {
      // A tall room is counted once, on the storey it is rooted on --
      // the same rule `reachabilityProblems` uses, so a two-storey volume
      // is not reported twice for one wall.
      if (room.level !== level || !sleepingOf(room.roomType)) continue;
      const exteriorM = exteriorWallLength(boxes, level, autoCarve, room.id);
      if (exteriorM < MIN_EXTERIOR_WALL_M) out.push({ roomId: room.id, exteriorM, level });
    }
  }
  return out;
}

/** Exterior wall shorter than this on one facade is a return or a
 * chamfer, not a wall a window goes in -- so it does not count as an
 * aspect of its own. Half the escape-opening width, deliberately: this
 * is asking "could there be a window here at all", one step weaker than
 * `MIN_EXTERIOR_WALL_M` asking "could there be an escape window here". */
const MIN_ASPECT_WALL_M = 0.5;

/** Outward-facing directions are bucketed this coarsely -- eight sectors
 * of 45 degrees, the eight compass points. Finer would split one flat
 * facade in two the moment a room is rotated a few degrees; coarser
 * would merge a north wall with an east one and call a corner room
 * single-aspect. */
const ASPECT_SECTORS = 8;

export interface SingleAspectFinding {
  roomId: string;
  /** How much outside-facing wall the room has in total, meters -- it
   * can be plenty and still all face one way, which is exactly the case
   * this reports. */
  exteriorM: number;
  level: number;
}

/** Which way each edge of `poly` faces, as a sector index, paired with
 * how much of that edge is exterior. Winding is read from the polygon's
 * own signed area rather than assumed: `displayShapes` hands back
 * polygons from a boolean operation, and nothing guarantees they wind
 * the same way `rectPolyOf` does. */
function outwardSector(a: Point, b: Point, counterClockwise: boolean): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  // In this plan frame (y down) a positive signed area means the outward
  // normal of edge a->b is (dy, -dx); the other winding flips it.
  const nx = counterClockwise ? dy : -dy;
  const ny = counterClockwise ? -dx : dx;
  const angle = Math.atan2(ny, nx);
  const sector = Math.round((angle / (2 * Math.PI)) * ASPECT_SECTORS);
  return ((sector % ASPECT_SECTORS) + ASPECT_SECTORS) % ASPECT_SECTORS;
}

function signedArea(poly: Poly): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * Every habitable room whose outside-facing wall all points one way --
 * a single-aspect room. Air only moves through a room when it has
 * somewhere to come in and somewhere to go out; openings on one facade
 * give a room daylight and give it nothing else, so it overheats in the
 * afternoon and stays hot at night. A second facade -- opposite for a
 * through draught, or round a corner for a weaker but real one -- is what
 * lets a room purge its own heat, which in a Gulf climate is the
 * difference between a room that works in summer without mechanical help
 * and one that does not. Dual aspect is a stated preference in
 * residential design guidance generally (the London Plan's discouragement
 * of single-aspect dwellings is the best-known written form of it) and is
 * older than any of that as vernacular practice in hot climates.
 *
 * A soft recommendation, not a hard problem, and the line is the same one
 * `efficiency.ts` draws: a single-aspect bedroom works. It is more
 * expensive to keep comfortable and less pleasant to be in. It is not a
 * room you cannot use, which is what `windowlessSleepingRooms` above
 * reports.
 *
 * A room with no exterior wall at all is not reported here. It has a
 * worse problem, already named by the check above or (for a room type
 * that is not slept in) legitimately internal; adding a second finding
 * for the same wall would just say the same thing twice.
 */
export function singleAspectRooms(
  boxes: Box[],
  storeys: number,
  autoCarve: boolean,
  habitableOf: (roomType: string) => boolean,
): SingleAspectFinding[] {
  const out: SingleAspectFinding[] = [];
  for (let level = 0; level < storeys; level++) {
    const live = liveBoxes(boxes, level);
    const shapes = displayShapesForLevelMemo(boxes, level, autoCarve);
    const { touchGraph } = levelTouchDataMemo(boxes, level, autoCarve);
    for (let i = 0; i < live.length; i++) {
      const room = live[i];
      if (room.level !== level || !habitableOf(room.roomType)) continue;
      const poly = shapes[i].page;
      const runs = (touchGraph.get(room.id) ?? []).map((e) => e.touch);
      const counterClockwise = signedArea(poly) > 0;
      const bySector = new Map<number, number>();
      let exteriorM = 0;
      for (let e = 0; e < poly.length; e++) {
        const a = poly[e];
        const b = poly[(e + 1) % poly.length];
        const exposed = exposedOnEdge(a, b, runs);
        if (exposed <= 0) continue;
        exteriorM += exposed;
        if (exposed < MIN_ASPECT_WALL_M) continue;
        const sector = outwardSector(a, b, counterClockwise);
        bySector.set(sector, (bySector.get(sector) ?? 0) + exposed);
      }
      // No usable exterior wall at all is a different (worse) finding,
      // reported elsewhere or legitimately fine -- not one more instance
      // of this one.
      if (bySector.size === 1) out.push({ roomId: room.id, exteriorM, level });
    }
  }
  return out;
}

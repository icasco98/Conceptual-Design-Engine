/**
 * Two things the four relationship checks (relationships.ts,
 * circulation.ts) never asked about, because they answer a different
 * question: not "does this work" but "is this wasting money."
 *
 * `unnecessaryGaps` and `circulationRatio` are the missing cost axis for
 * `scoreCandidate` -- without them, nothing stops an optimizer (a person
 * taking a shortcut, or a future generator, Task 8/9) from satisfying
 * every `desired` hop<=2 pairing the cheapest possible way: one hallway
 * everything hangs off, with gaps left wherever a shared wall wasn't
 * strictly required. That plan passes reachability, tier, adjacency and
 * stair-connection cleanly, and still costs more to build than it needs
 * to. Neither check here is a correctness rule -- a house with an
 * over-sized hallway or an unclosed gap still *works* -- so both are
 * always soft recommendations, never hard problems, the same severity
 * `desired` already has.
 */
import { displayShapes } from "./carve";
import { polyArea } from "./poly";
import { rectOf } from "./rect";
import { polyGap } from "./touch";
import { liveBoxes } from "./snap";
import type { Box } from "./types";

/** Below this, two outlines are touching (or as good as, past floating-
 * point noise) -- not a gap at all, nothing to flag. Reuses the same
 * tolerance `circulation.ts` uses for "is a door actually on this wall." */
const TOUCHING_TOL_M = 0.04;

/** Above this, two rooms were never going to share a wall regardless --
 * this is not "how close is close," it is "close enough that a person
 * dragging one zone would expect it to snap to the other." Reuses
 * `touch.ts`'s own `TOUCH_REACH_M`: the "make selected zones touch"
 * feature already treats this distance as "these were probably meant to
 * meet," so a gap check uses the same number rather than a second,
 * slightly different one for the same judgment. */
const GAP_THRESHOLD_M = 1.0;

export interface GapFinding {
  roomAId: string;
  roomBId: string;
  /** The shortest distance between the two outlines, meters. */
  gapM: number;
  level: number;
}

/**
 * Every pair of placed rooms, on the same storey, sitting apart by more
 * than a floating-point touch but no more than `GAP_THRESHOLD_M` --
 * close enough that closing the gap would trade two exterior walls for
 * one shared interior one, at no functional cost. Exempt whenever
 * `isUndesiredPair` says the two room types are meant to stay apart (a
 * garage's fumes reaching a bedroom, say): that gap is doing real work,
 * not wasting money, and this check has no business second-guessing it.
 * `isUndesiredPair` is a parameter rather than a direct read of
 * `ROOM_RELATIONSHIPS` so this file never needs to import
 * relationships.ts (which imports this one) -- the same "hand in the
 * policy, don't go read it yourself" shape every other predicate
 * parameter in this codebase already has (`passableOf`, `tierOf`, ...).
 */
export function unnecessaryGaps(
  boxes: Box[],
  storeys: number,
  autoCarve: boolean,
  isUndesiredPair: (typeA: string, typeB: string) => boolean,
): GapFinding[] {
  const out: GapFinding[] = [];
  for (let level = 0; level < storeys; level++) {
    const live = liveBoxes(boxes, level);
    const shapes = displayShapes(live, autoCarve);
    for (let i = 0; i < live.length; i++) {
      const ra = rectOf(live[i]);
      for (let j = i + 1; j < live.length; j++) {
        if (isUndesiredPair(live[i].roomType, live[j].roomType)) continue;
        const rb = rectOf(live[j]);
        // Conservative bounding-box reject: each outline sits inside its
        // own rect, so if the rects (each grown by the threshold) don't
        // even overlap, the real outlines are certainly farther apart
        // than the threshold -- never a false negative, just skips the
        // exact polygon math for pairs nowhere near each other.
        const farInX = ra.left > rb.left + rb.width + GAP_THRESHOLD_M || rb.left > ra.left + ra.width + GAP_THRESHOLD_M;
        const farInY = ra.top > rb.top + rb.height + GAP_THRESHOLD_M || rb.top > ra.top + ra.height + GAP_THRESHOLD_M;
        if (farInX || farInY) continue;
        const { d } = polyGap(shapes[i].page, shapes[j].page);
        if (d > TOUCHING_TOL_M && d <= GAP_THRESHOLD_M) {
          out.push({ roomAId: live[i].id, roomBId: live[j].id, gapM: d, level });
        }
      }
    }
  }
  return out;
}

/** Above this fraction of a storey's own room area, its circulation
 * rooms (rooms.ts's `circulation` -- Entry, Hallway, Mudroom, Stair) are
 * taking up more of the floor than a house this size needs to spend on
 * moving between rooms rather than living in them. Provisional: a
 * reasoned "typical efficient residential circulation runs 10-15% of
 * floor area," not a specific citation -- flagged here the same way the
 * relationship table flags its own unsourced-but-defensible rows, for
 * the same later validation. */
const CIRCULATION_RATIO_THRESHOLD = 0.15;

export interface CirculationRatioFinding {
  level: number;
  /** Circulation-room area over total room area on this storey, 0..1. */
  ratio: number;
}

/**
 * Every storey whose circulation rooms eat more than
 * `CIRCULATION_RATIO_THRESHOLD` of its own total room area. Counts every
 * room live on the storey exactly the way the status bar's own "area on
 * this floor" figure already does (including a tall zone's footprint on
 * every storey it spans, a stair's real floor area both up and down) --
 * one consistent notion of "how much of this floor is used," not a
 * second one that answers slightly differently.
 */
export function circulationRatio(
  boxes: Box[],
  storeys: number,
  autoCarve: boolean,
  circulationOf: (roomType: string) => boolean,
): CirculationRatioFinding[] {
  const out: CirculationRatioFinding[] = [];
  for (let level = 0; level < storeys; level++) {
    const live = liveBoxes(boxes, level);
    const shapes = displayShapes(live, autoCarve);
    let total = 0;
    let circulation = 0;
    for (let i = 0; i < live.length; i++) {
      const area = polyArea(shapes[i].page);
      total += area;
      if (circulationOf(live[i].roomType)) circulation += area;
    }
    if (total <= 0) continue;
    const ratio = circulation / total;
    if (ratio > CIRCULATION_RATIO_THRESHOLD) out.push({ level, ratio });
  }
  return out;
}

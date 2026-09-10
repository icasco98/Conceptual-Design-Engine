/**
 * Four things the four relationship checks (relationships.ts,
 * circulation.ts) never asked about, because they answer a different
 * question: not "does this work" but "is this wasting money" -- with one
 * deliberate exception (`deadEndHallways`' own life-safety finding, see
 * its own doc comment for why that one is not cost at all).
 *
 * `unnecessaryGaps`, `circulationRatio`, `overhangs` and `corridorWaste`
 * are the missing cost axis for `scoreCandidate` -- without them,
 * nothing stops an optimizer (a person taking a shortcut, or a future
 * generator, Task 8/9) from satisfying every `desired` hop<=2 pairing the
 * cheapest possible way: one hallway everything hangs off, with gaps
 * left wherever a shared wall wasn't strictly required, mismatched
 * neighbours left jogging past each other, and a corridor built longer
 * than any door on it needs. That plan passes reachability, tier,
 * adjacency and stair-connection cleanly, and still costs more to build
 * than it needs to -- so these four are always soft recommendations,
 * never hard problems, the same severity `desired` already has.
 */
import { buildCirculationGraphMemo, displayShapesForLevelMemo, levelTouchDataMemo } from "./memo";
import { polyArea } from "./poly";
import { rectOf } from "./rect";
import { polyGap } from "./touch";
import { liveBoxes } from "./snap";
import type { Arrow, Box } from "./types";

/** Below this, two outlines are touching (or as good as, past floating-
 * point noise) -- not a gap at all, nothing to flag. Reuses the same
 * tolerance `circulation.ts` uses for "is a door actually on this wall." */
export const TOUCHING_TOL_M = 0.04;

/** Above this, two rooms were never going to share a wall regardless --
 * this is not "how close is close," it is "close enough that a person
 * dragging one zone would expect it to snap to the other." Reuses
 * `touch.ts`'s own `TOUCH_REACH_M`: the "make selected zones touch"
 * feature already treats this distance as "these were probably meant to
 * meet," so a gap check uses the same number rather than a second,
 * slightly different one for the same judgment. */
export const GAP_THRESHOLD_M = 1.0;

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
    const shapes = displayShapesForLevelMemo(boxes, level, autoCarve);
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
export const CIRCULATION_RATIO_THRESHOLD = 0.15;

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
    const shapes = displayShapesForLevelMemo(boxes, level, autoCarve);
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

/** Past this much of a wall left uncovered by whatever else is touching
 * it, the mismatch is a real jog in the building's own outline, not
 * ordinary construction tolerance -- the same reach `unnecessaryGaps`
 * already uses for "this is a real, priced difference," not a second,
 * slightly different number for the same kind of judgment. */
export const OVERHANG_THRESHOLD_M = 1.0;

export interface OverhangFinding {
  roomId: string;
  /** The neighbour whose own touch leaves the rest of this wall exposed. */
  neighborId: string;
  /** 0 top, 1 right, 2 bottom, 3 left -- rect.ts's own convention. */
  side: number;
  /** How much of this side is left over past every neighbour touching
   * it, meters -- exposed wall the building pays for regardless of
   * whether a door is ever cut into it. */
  exposedM: number;
  level: number;
}

/** [lo, hi) intervals merged into their total covered length -- the one
 * piece of interval math `overhangs` (per wall), `corridorWaste` (per
 * corridor) and `habitability.ts`'s `exteriorWallLength` (per edge of a
 * room's outline) all need, so it exists once rather than three times.
 * Merging first is the whole point: two neighbours meeting the same
 * stretch of wall must not have that stretch subtracted twice. */
export function unionLength(intervals: [number, number][]): number {
  if (!intervals.length) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [lo, hi] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = sorted[i];
    if (a <= hi + 1e-6) hi = Math.max(hi, b);
    else {
      total += hi - lo;
      [lo, hi] = [a, b];
    }
  }
  total += hi - lo;
  return total;
}

/**
 * Every room whose own wall, on one side, runs past every neighbour
 * actually touching it there -- a step in the exterior wall line a
 * differently-sized or differently-placed neighbour created, costing a
 * real corner and a real extra run of foundation and roof, whether or
 * not the two rooms share a door. A side with *no* neighbour at all is
 * not reported: that is just an ordinary exterior wall, not a jog past
 * one -- this only fires where something is touching part of a wall and
 * leaving the rest of that same wall exposed.
 *
 * Rectangles only, unrotated: a side is only a well-defined thing to
 * measure "along" for an axis-aligned rect. A rotated box or hand-drawn
 * polygon has no single "side 0..3" to walk, so it is skipped here
 * rather than guessed at -- a real, narrow scope limit, not a silent
 * wrong answer for the shapes this does cover.
 */
export function overhangs(boxes: Box[], storeys: number, autoCarve: boolean): OverhangFinding[] {
  const out: OverhangFinding[] = [];
  for (let level = 0; level < storeys; level++) {
    const live = liveBoxes(boxes, level);
    const byId = new Map(live.map((b) => [b.id, b]));
    const { touchGraph } = levelTouchDataMemo(boxes, level, autoCarve);
    for (const room of live) {
      if (room.shape !== "rect" || (room.rotation ?? 0) % 360 !== 0) continue;
      const r = rectOf(room);
      const edges = touchGraph.get(room.id) ?? [];
      // Bucket every touch this room has by which of its own four sides
      // it actually sits on -- a touch is only usable here when both its
      // endpoints sit flush on one side, within the same tolerance the
      // touch graph itself was built with.
      const bySide: [number, number][][] = [[], [], [], []];
      const neighborOf: (string | undefined)[][] = [[], [], [], []];
      for (const e of edges) {
        const { p1, p2 } = e.touch;
        const onTop = Math.abs(p1[1] - r.top) < TOUCHING_TOL_M && Math.abs(p2[1] - r.top) < TOUCHING_TOL_M;
        const onBottom = Math.abs(p1[1] - (r.top + r.height)) < TOUCHING_TOL_M && Math.abs(p2[1] - (r.top + r.height)) < TOUCHING_TOL_M;
        const onLeft = Math.abs(p1[0] - r.left) < TOUCHING_TOL_M && Math.abs(p2[0] - r.left) < TOUCHING_TOL_M;
        const onRight = Math.abs(p1[0] - (r.left + r.width)) < TOUCHING_TOL_M && Math.abs(p2[0] - (r.left + r.width)) < TOUCHING_TOL_M;
        const side = onTop ? 0 : onRight ? 1 : onBottom ? 2 : onLeft ? 3 : -1;
        if (side === -1) continue; // a rotated or carved neighbour's edge, not flush on any one side
        const along: [number, number] = side === 0 || side === 2 ? [Math.min(p1[0], p2[0]), Math.max(p1[0], p2[0])] : [Math.min(p1[1], p2[1]), Math.max(p1[1], p2[1])];
        bySide[side].push(along);
        neighborOf[side].push(e.to);
      }
      const fullLength = [r.width, r.height, r.width, r.height];
      for (let side = 0; side < 4; side++) {
        if (!bySide[side].length) continue; // nothing touches this side at all -- an ordinary exterior wall
        const covered = unionLength(bySide[side]);
        const exposed = fullLength[side] - covered;
        if (exposed <= OVERHANG_THRESHOLD_M) continue;
        // Blame the neighbour whose own touch is longest on this side --
        // the wall's real relationship, not whichever happened to sort
        // first.
        let bestIdx = 0;
        for (let i = 1; i < bySide[side].length; i++) {
          const len = (a: [number, number]) => a[1] - a[0];
          if (len(bySide[side][i]) > len(bySide[side][bestIdx])) bestIdx = i;
        }
        const neighborId = neighborOf[side][bestIdx];
        if (!neighborId || !byId.has(neighborId)) continue;
        out.push({ roomId: room.id, neighborId, side, exposedM: exposed, level });
      }
    }
  }
  return out;
}

/** Past this stub length, a corridor is running further than its own
 * doors need it to -- a fraction of even the tool's own minimum corridor
 * width (1.2 m), so a genuine construction margin (a door's own inset,
 * DOOR_INSET_M) never trips this on its own. */
export const CORRIDOR_STUB_THRESHOLD_M = 0.5;

export interface CorridorWasteFinding {
  roomId: string;
  /** Combined length of both ends left over past the doors actually on
   * this corridor, meters. */
  wastedM: number;
  level: number;
}

/**
 * Every `kind: "corridor"` room (Hallway, Landing -- the two spines this
 * house's own doors actually run along) whose own long axis reaches past
 * every door it carries. A corridor's job is to carry doors, not to be a
 * room in its own right; length nothing opens onto is the same wasted
 * floor area `circulationRatio` prices by the square metre, named here by
 * its actual shape instead -- a stub at one or both ends, not spread
 * evenly across the whole room.
 *
 * Reads door positions from `buildCirculationGraph`'s own edges (each
 * one's real page-frame midpoint, `mid`) rather than walking `arrows`
 * directly, so a door counts here exactly when it counts as a real
 * connection everywhere else in this tool -- whichever side happens to
 * host the arrow.
 */
export function corridorWaste(boxes: Box[], storeys: number, arrows: Arrow[], autoCarve: boolean): CorridorWasteFinding[] {
  const out: CorridorWasteFinding[] = [];
  const graph = buildCirculationGraphMemo(boxes, storeys, arrows, autoCarve);
  for (let level = 0; level < storeys; level++) {
    for (const room of liveBoxes(boxes, level)) {
      if (room.kind !== "corridor" || room.level !== level) continue;
      const r = rectOf(room);
      const long: 0 | 1 = r.width >= r.height ? 0 : 1; // 0 = x is the long axis, 1 = y is
      const start = long === 0 ? r.left : r.top;
      const length = long === 0 ? r.width : r.height;
      const doorPositions = (graph.get(room.id) ?? []).map((e) => (long === 0 ? e.mid[0] : e.mid[1]));
      if (!doorPositions.length) continue; // no doors at all is reachabilityProblems' own finding, not this one's
      const covered = [Math.min(...doorPositions) - start, Math.max(...doorPositions) - start];
      const wasted = Math.max(0, covered[0]) + Math.max(0, length - covered[1]);
      if (wasted > CORRIDOR_STUB_THRESHOLD_M) out.push({ roomId: room.id, wastedM: wasted, level });
    }
  }
  return out;
}

/** Past this real walking distance from a corridor that is the *only*
 * way out, a stranded branch is a life-safety defect, not merely a
 * cost -- the ~6 m (20 ft) dead-end-corridor figure common to
 * residential building codes (e.g. IBC), not this project's own guess.
 * Unlike every other finding in this file, this one is a hard problem:
 * see `deadEndHallways`'s own doc comment for why. */
export const DEAD_END_LIMIT_M = 6.0;

export interface DeadEndFinding {
  /** The circulation room whose own removal strands the branch below. */
  hallwayId: string;
  /** The room deepest into the stranded branch -- farthest from the one
   * way out, so a message can say how far someone in it would have to
   * backtrack before there even is a second direction to go. */
  farRoomId: string;
  /** Real walking distance from the hallway to that room, meters
   * (`circulation.ts`'s own edge weights -- straight-line, door to door,
   * the same distance `shortestPath` already routes actors by). */
  distanceM: number;
  level: number;
}

/**
 * Every circulation room that is the *sole* connection between some part
 * of the plan and every exterior door, where that stranded part reaches
 * more than `DEAD_END_LIMIT_M` away. This is not `corridorWaste` again --
 * a corridor can carry every one of its own doors right up to its own
 * far wall and still be exactly this kind of dead end, if that wall (and
 * everything behind it) has no other way out. And it is not
 * `reachabilityProblems` either: everything in the stranded branch *is*
 * reachable, by one route -- the danger is that it is only one route, not
 * that it is none.
 *
 * This is the one finding in this file that is a hard problem, not a
 * recommendation: the other three (`unnecessaryGaps`, `circulationRatio`,
 * `overhangs`, `corridorWaste`) are about what a plan costs to build; a
 * dead-end corridor past a real code limit is about whether the people in
 * it can get out, which is exactly the same kind of defect an unmet
 * `required` adjacency or a reachability problem already is.
 *
 * Implementation: a standard articulation-point search (Tarjan) over the
 * circulation graph plus one virtual "outside" node wired to every
 * exterior door's own host -- a room the search marks as an articulation
 * point, separating a DFS child's subtree from "outside", is exactly a
 * sole-route gatekeeper. Only `kind: "corridor"` rooms are ever reported
 * as one, deliberately narrower than every other room this same search
 * technically also implicates: the house's own front entry is almost
 * always one too (remove it and the whole house is cut off), and so is
 * a single stair serving an upper storey -- neither is a corridor
 * defect, that is just what a single-entrance, single-stair home *is*,
 * the ordinary case this tool's own sample house is one instance of.
 * `corridorWaste` already uses the same `kind` field to mean the same
 * thing: an actual corridor, not any room a person can walk through.
 *
 * For each qualifying cut point, the branch itself is found by walking
 * from the DFS child with the gatekeeper removed (never assumed from
 * DFS bookkeeping, so a real graph cycle elsewhere in the plan is never
 * mistaken for one more dead end), and the reported distance is the
 * farthest real walking distance from the gatekeeper to anything in it --
 * except that a further `kind: "corridor"` room is never the reported far
 * point, and the walk never continues past one to compound its own depth
 * onto this one's. That further corridor is its own separately-checked
 * dead end (this same function, run again with it as the gatekeeper);
 * without this, a stair or a second corridor behind the first would keep
 * compounding this one's own reported depth with a run it doesn't own,
 * and even an ordinary two-storey house with one stair and one corridor
 * per floor would read as a single dead end stretching from the front
 * door to the far bedroom, rather than what it actually is: two short,
 * separately-fine corridors joined by a stair.
 */
export function deadEndHallways(boxes: Box[], storeys: number, arrows: Arrow[], autoCarve: boolean): DeadEndFinding[] {
  const out: DeadEndFinding[] = [];
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const graph = buildCirculationGraphMemo(boxes, storeys, arrows, autoCarve);
  const roots = new Set(arrows.filter((a) => a.kind === "exterior-main" || a.kind === "exterior-side").map((a) => a.hostId));
  if (!roots.size) return out;

  const OUTSIDE = "\0outside";
  const aug = new Map<string, { to: string }[]>();
  const addEdge = (a: string, b: string) => {
    const list = aug.get(a) ?? [];
    list.push({ to: b });
    aug.set(a, list);
  };
  for (const [from, edges] of graph) for (const e of edges) addEdge(from, e.to);
  for (const root of roots) {
    addEdge(OUTSIDE, root);
    addEdge(root, OUTSIDE);
  }

  // Tarjan's articulation points, from OUTSIDE as the DFS root. Iterative
  // (an explicit stack), not recursive: a long corridor chain is exactly
  // the shape that would blow a call stack a plan-sized recursion never
  // otherwise risks.
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string | null>();
  let timer = 0;
  // Cut points found as (gatekeeper, child) pairs -- the child names
  // which DFS subtree got cut off, not just that a cut happened. OUTSIDE
  // itself is never recorded as a gatekeeper (see the `p !== OUTSIDE`
  // guard below): with more than one exterior door, OUTSIDE having
  // several DFS children just means several independent ways in, which
  // is the opposite of a dead end, not one more instance of it.
  const cuts: { gatekeeper: string; child: string }[] = [];

  const stack: { id: string; iter: number }[] = [{ id: OUTSIDE, iter: 0 }];
  disc.set(OUTSIDE, timer);
  low.set(OUTSIDE, timer);
  timer++;
  parent.set(OUTSIDE, null);

  while (stack.length) {
    const frame = stack[stack.length - 1];
    const u = frame.id;
    const neighbors = aug.get(u) ?? [];
    if (frame.iter < neighbors.length) {
      const v = neighbors[frame.iter].to;
      frame.iter++;
      if (!disc.has(v)) {
        disc.set(v, timer);
        low.set(v, timer);
        timer++;
        parent.set(v, u);
        stack.push({ id: v, iter: 0 });
      } else if (v !== parent.get(u)) {
        low.set(u, Math.min(low.get(u)!, disc.get(v)!));
      }
    } else {
      stack.pop();
      const p = parent.get(u)!;
      if (p !== null) {
        low.set(p, Math.min(low.get(p)!, low.get(u)!));
        if (p !== OUTSIDE && low.get(u)! >= disc.get(p)!) cuts.push({ gatekeeper: p, child: u });
      }
    }
  }

  for (const { gatekeeper, child } of cuts) {
    const gate = byId.get(gatekeeper);
    if (!gate || gate.kind !== "corridor") continue;
    // The branch itself: everything reachable from `child` with the
    // gatekeeper removed -- not assumed from the DFS tree, so a second,
    // real path elsewhere (a loop in the plan) correctly empties this out
    // rather than being reported as one more dead end.
    const branch = new Set<string>([child]);
    const queue = [child];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of graph.get(cur) ?? []) {
        if (e.to === gatekeeper || branch.has(e.to)) continue;
        branch.add(e.to);
        queue.push(e.to);
      }
    }
    // `graph` never contains the virtual OUTSIDE node (only `aug`,
    // Tarjan's own working copy, does) -- an exterior door's own host
    // being in the branch is what a real second way out actually looks
    // like here.
    let hasOwnExit = false;
    for (const root of roots) {
      if (branch.has(root)) {
        hasOwnExit = true;
        break;
      }
    }
    if (hasOwnExit) continue;

    // Farthest real walking distance from the gatekeeper to anything in
    // the branch -- Dijkstra on the real (unaugmented) graph, since the
    // branch is only reachable through the gatekeeper anyway.
    const dist = new Map<string, number>([[gatekeeper, 0]]);
    const visited = new Set<string>();
    const pq = [gatekeeper];
    while (pq.length) {
      pq.sort((a, b) => (dist.get(a) ?? Infinity) - (dist.get(b) ?? Infinity));
      const u = pq.shift()!;
      if (visited.has(u)) continue;
      visited.add(u);
      // A further corridor is its own separately-checked dead end -- stop
      // here rather than compounding this one's own depth with a run
      // that isn't this corridor's to answer for.
      if (u !== gatekeeper && byId.get(u)?.kind === "corridor") continue;
      for (const e of graph.get(u) ?? []) {
        const nd = (dist.get(u) ?? Infinity) + e.weight;
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          pq.push(e.to);
        }
      }
    }
    let farId: string | null = null;
    let farD = -1;
    for (const id of branch) {
      // A further corridor is never itself the "far point" -- it is the
      // start of its own separately-reported dead end (or not one at
      // all, if it has a second way out), not one more room this
      // gatekeeper's own depth should be blamed for.
      if (byId.get(id)?.kind === "corridor") continue;
      const d = dist.get(id) ?? -1;
      if (d > farD) {
        farD = d;
        farId = id;
      }
    }
    if (farId && farD > DEAD_END_LIMIT_M) {
      out.push({ hallwayId: gatekeeper, farRoomId: farId, distanceM: farD, level: gate.level });
    }
  }
  return out;
}

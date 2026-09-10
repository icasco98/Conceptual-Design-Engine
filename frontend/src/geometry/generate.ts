/**
 * The generator: searches for a better arrangement of the rooms already
 * on one storey, rather than requiring a person to place every one by
 * hand and iterate through trial and error.
 *
 * Not a from-scratch "design me a house" step. The room *program* --
 * which rooms exist, their `roomType`, their tier -- is fixed, the same
 * way `arrows.ts`'s `suggestArrows` proposes doors for a fixed set of
 * rooms rather than inventing rooms of its own. What this searches is
 * *placement*: each movable room's position, rotation and size (never
 * below its own `minWidth`/`minHeight`). Letting size flex, not just
 * position, is what makes a real building footprint an emergent result
 * of the search rather than something authored separately --
 * `footprint.ts`'s `footprintRings` already derives the outline as the
 * union of whatever is placed, so a tightly- or loosely-packed candidate
 * automatically produces a compact or expansive footprint with no
 * separate massing step.
 *
 * Only rooms rooted on the requested storey (`Box.level === level`, not
 * merely visible there because a taller zone reaches up into it) are
 * ever moved. Everything else -- other storeys, unplaced rooms, the
 * room program itself, the adjacency rules, every room's privacy tier --
 * is exactly as the caller left it.
 *
 * Objective: NOT blanket coverage-maximization. A fixed "always fill the
 * plot" target breaks down across plot sizes -- a large plot should not
 * be built wall-to-wall just because it can be. Instead candidates are
 * ranked by `relationships.ts`'s own `compareScores` (hard problems
 * first, then Phase 2's severity-weighted soft recommendations) --
 * exactly the ordering a person reading the status bar already trusts,
 * so the generator never optimizes toward something the rest of the
 * tool doesn't also consider good. `footprintCoverage` (footprint.ts) is
 * computed once at the end purely for the caller to report, not used to
 * steer the search.
 *
 * Search: simulated annealing over single-candidate perturbations
 * (nudge one room's position/rotation/size, swap two rooms, or snap one
 * room flush against its nearest neighbour -- see `MoveKind`), not a
 * genetic algorithm -- there is no sane way to "cross over" two spatial
 * arrangements into a third valid one, and a single evolving candidate
 * is the standard approach for continuous spatial layout. Every
 * perturbation is cheaply rejected (no overlap with another live room on
 * this storey, `rect.ts`'s `boxesTrulyIntersect`; still inside the site
 * boundary, see `withinBoundary` below) *before* the expensive
 * `scoreCandidate` is ever called on it -- the actual performance
 * strategy, on top of `memo.ts`'s caching of the geometry `scoreCandidate`
 * itself rebuilds.
 *
 * Doors are part of the fitness function, not a step bolted on before or
 * after the search: every candidate that survives the cheap filter has
 * its own doors freshly proposed (`arrows.ts`'s `suggestArrows`, the
 * storey being searched only) before `scoreCandidate` ever sees it, so
 * reachability and required-adjacency are real, live signals the search
 * responds to, the same way a hard problem in any other check is. A
 * search that scored candidates against one fixed door set could not
 * tell "this move made a room reachable" from "this move did nothing" --
 * it would only ever be optimizing position around a circulation picture
 * that never changes.
 *
 * The best candidate found (by `compareScores`) is tracked separately
 * from the annealing walk and returned at the end, regardless of where
 * the stochastic walk itself ends up -- standard SA practice, and what
 * guarantees the result is never worse than the arrangement the search
 * started from: the starting arrangement is `best`'s own initial value,
 * and `best` is only ever replaced by something `compareScores` ranks
 * strictly better.
 *
 * Site constraint: a boundary *polygon*, not specifically a rectangle --
 * today's caller builds one from the plain plot rectangle
 * (`geometry/plot.ts`'s `Plot`, its only shape today), but a future
 * setback-inset boundary is a drop-in replacement for that one argument,
 * with no change to this search loop, its cheap-reject step, or
 * `withinBoundary` itself.
 */
import { suggestArrows } from "./arrows";
import { pointOnPolyBoundary, polyOfBox } from "./poly";
import { boxesTrulyIntersect } from "./rect";
import { compareScores, scoreCandidate, type RelationRow, type Score } from "./relationships";
import { liveBoxes, snapToNearbyNeighbors } from "./snap";
import type { Arrow, Box, Point, Poly, RoomFacts } from "./types";

/** A millimetre -- the same generosity `plot.ts`'s own boundary test
 * gives a zone sitting right on the line. */
const BOUNDARY_EPS = 1e-3;

/** Ray-casting point-in-polygon, with a point right on the boundary line
 * itself (within `BOUNDARY_EPS`) counted as inside -- floating point puts
 * a corner a hair either side of an edge it was deliberately placed on. */
function pointInPolygon(p: Point, poly: Poly): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const crosses = yi > p[1] !== yj > p[1];
    if (crosses && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside || pointOnPolyBoundary(poly, p, BOUNDARY_EPS);
}

/** Every corner of `box`'s own turned outline sits inside `boundary` --
 * `null` means no site constraint at all (the plot switched off). */
function withinBoundary(box: Box, boundary: Poly | null): boolean {
  if (!boundary) return true;
  return polyOfBox(box).every((p) => pointInPolygon(p, boundary));
}

/** A small, fast, seedable PRNG (mulberry32) -- not cryptographic, just
 * reproducible: the same seed always walks the same search, which is
 * what lets a test assert on the result deterministically. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Every number that shapes *how* the search walks -- never what counts
 * as a good layout (that stays `relationships.ts`'s rule set, untouched
 * by this file) -- pulled out into one object so `scenarios.student.ts`
 * can propose and evaluate different configurations without duplicating
 * the search loop itself. `DEFAULT_SEARCH_CONFIG` is today's
 * hand-picked baseline; every existing caller that doesn't pass its own
 * config gets exactly that, unchanged.
 */
export interface SearchConfig {
  /** Where the annealing schedule starts and (asymptotically) ends --
   * chosen so a hard-problem difference (`hardProblemWeight`) is very
   * unlikely to be accepted even at the start, while a small soft-
   * recommendation difference still can be, and by the final iteration
   * essentially nothing worse is ever accepted. */
  tStart: number;
  tEnd: number;
  /** How much one hard problem outweighs the entire soft-recommendation
   * total in the acceptance test -- large enough that no plausible soft
   * improvement ever makes accepting a worse hard-problem count look
   * attractive, matching `compareScores`' own "hard problems always
   * decide first." Only shapes the stochastic walk; the *returned*
   * candidate is never worse than the start regardless (see the file
   * doc comment). */
  hardProblemWeight: number;
  /** Translate/resize step size in meters is `stepFloorM +
   * stepScaleM * (temperature / tStart)` -- large early on, shrinking
   * to `stepFloorM` as the search cools. Same shape for rotation, in
   * degrees. */
  stepFloorM: number;
  stepScaleM: number;
  rotFloorDeg: number;
  rotScaleDeg: number;
  /** Relative odds of each move kind being tried on a given iteration
   * (need not sum to 1 -- normalized when picked). `snap` is the one move
   * that closes a gap deliberately rather than by lucky random landing --
   * see `propose` below -- which is why it gets its own weight here for
   * `scenarios.student.ts` to tune, exactly like every other move kind. */
  moveWeights: { translate: number; resize: number; rotate: number; swap: number; snap: number };
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  tStart: 3,
  tEnd: 0.002,
  hardProblemWeight: 1000,
  stepFloorM: 0.1,
  stepScaleM: 2.5,
  rotFloorDeg: 1,
  rotScaleDeg: 20,
  // snap starts at a modest weight relative to the four continuous moves:
  // it is the one move that can make a room touch a neighbour outright,
  // so even a modest share of iterations spent on it should matter far
  // more than its frequency alone suggests. scenarios.student.ts is free
  // to retune this once the mechanism is in place.
  moveWeights: { translate: 1, resize: 1, rotate: 1, swap: 1, snap: 1 },
};

export interface GenerateOptions {
  /** How many perturbations to try. More finds a better arrangement at
   * the cost of time; the default is tuned for a house-sized room count
   * (well under a second for a few dozen rooms). */
  iterations?: number;
  /** Fixed seed for a reproducible run. Omit for a fresh random search
   * each call. */
  seed?: number;
  /** How the search walks -- defaults to `DEFAULT_SEARCH_CONFIG`. */
  config?: SearchConfig;
}

const DEFAULT_ITERATIONS = 600;

type MoveKind = "translate" | "resize" | "rotate" | "swap" | "snap";

/** `box`, nudged by one of the three continuous move kinds, sized to
 * `stepM`/`rotStepDeg` -- shrinking as the search cools -- and always kept
 * at or above its own `minWidth`/`minHeight` by construction, never
 * rejected for it afterwards. `swap` and `snap` are not continuous
 * perturbations and are handled directly in `propose`, not here. */
function perturbOne(box: Box, kind: "translate" | "resize" | "rotate", rng: () => number, stepM: number, rotStepDeg: number): Box {
  if (kind === "translate") {
    return { ...box, left: box.left + (rng() - 0.5) * 2 * stepM, top: box.top + (rng() - 0.5) * 2 * stepM };
  }
  if (kind === "rotate") {
    return { ...box, rotation: box.rotation + (rng() - 0.5) * 2 * rotStepDeg };
  }
  // resize: about the box's own centre, so a shrink or grow doesn't also
  // silently relocate it the way growing only from left/top would.
  const dw = (rng() - 0.5) * 2 * stepM;
  const dh = (rng() - 0.5) * 2 * stepM;
  const width = Math.max(box.minWidth, box.width + dw);
  const height = Math.max(box.minHeight, box.height + dh);
  return { ...box, left: box.left - (width - box.width) / 2, top: box.top - (height - box.height) / 2, width, height };
}

/** One of `weights`' kinds, chosen with odds proportional to its own
 * weight -- e.g. `{translate: 2, resize: 1, rotate: 1, swap: 1}` tries
 * `translate` roughly twice as often as each of the others. A weight of
 * 0 means "never try this move" without needing a separate on/off flag. */
function pickMoveKind(rng: () => number, weights: SearchConfig["moveWeights"]): MoveKind {
  const kinds: MoveKind[] = ["translate", "resize", "rotate", "swap", "snap"];
  const total = kinds.reduce((s, k) => s + Math.max(0, weights[k]), 0);
  if (total <= 0) return "translate";
  let r = rng() * total;
  for (const k of kinds) {
    r -= Math.max(0, weights[k]);
    if (r <= 0) return k;
  }
  return kinds[kinds.length - 1];
}

/** One perturbed candidate array, and which movable ids it touched (so
 * the cheap-reject step only re-checks those, not every live pair).
 * `level` is only needed for `snap`, which has to know which other boxes
 * are actually live on this storey to find a neighbour to close a gap
 * against -- every other move kind never looks past the one box it
 * perturbs. */
function propose(
  current: Box[],
  movableIds: string[],
  level: number,
  rng: () => number,
  stepM: number,
  rotStepDeg: number,
  moveWeights: SearchConfig["moveWeights"],
): { candidate: Box[]; touchedIds: string[] } {
  const byId = new Map(current.map((b) => [b.id, b]));
  const kind = pickMoveKind(rng, moveWeights);
  if (kind === "swap" && movableIds.length >= 2) {
    const i = Math.floor(rng() * movableIds.length);
    let j = Math.floor(rng() * movableIds.length);
    if (j === i) j = (j + 1) % movableIds.length;
    const a = byId.get(movableIds[i])!;
    const b = byId.get(movableIds[j])!;
    const swappedA: Box = { ...a, left: b.left, top: b.top };
    const swappedB: Box = { ...b, left: a.left, top: a.top };
    return {
      candidate: current.map((box) => (box.id === swappedA.id ? swappedA : box.id === swappedB.id ? swappedB : box)),
      touchedIds: [a.id, b.id],
    };
  }
  if (kind === "snap") {
    const id = movableIds[Math.floor(rng() * movableIds.length)];
    const box = byId.get(id)!;
    // Axis-aligned only for now (see the file doc comment): `snap.ts`'s
    // gap-closing reads left/top/width/height directly and does not
    // account for a turned outline, exactly like the editor's own magnet
    // button that it's shared with. A rotated room just sits this
    // iteration out as a no-op rather than being pushed somewhere wrong
    // by a snap that can't see its true footprint -- the cheap filter and
    // scorer see no change and move on, same as any other move kind that
    // happens to find nothing to do.
    if (box.rotation !== 0) {
      return { candidate: current, touchedIds: [id] };
    }
    const live = liveBoxes(current, level);
    const snapped = snapToNearbyNeighbors(box, live);
    return { candidate: current.map((b) => (b.id === id ? snapped : b)), touchedIds: [id] };
  }
  const id = movableIds[Math.floor(rng() * movableIds.length)];
  const box = byId.get(id)!;
  const moved = perturbOne(box, kind === "swap" ? "translate" : kind, rng, stepM, rotStepDeg);
  return { candidate: current.map((b) => (b.id === id ? moved : b)), touchedIds: [id] };
}

/** Whether every id in `touchedIds` still fits the boundary and does not
 * truly overlap any other live room on `level` -- the cheap filter run
 * before the expensive `scoreCandidate`. Only the touched box(es) need
 * checking against everything else live: nothing else moved. */
function passesCheapFilter(candidate: Box[], level: number, touchedIds: string[], boundary: Poly | null): boolean {
  const live = liveBoxes(candidate, level);
  const byId = new Map(live.map((b) => [b.id, b]));
  for (const id of touchedIds) {
    const box = byId.get(id);
    if (!box) continue; // not live on this storey (shouldn't happen for a movable id, but never crash over it)
    if (!withinBoundary(box, boundary)) return false;
    for (const other of live) {
      if (other.id === box.id) continue;
      if (boxesTrulyIntersect(box, other)) return false;
    }
  }
  return true;
}

function combinedDelta(a: Score, b: Score, hardProblemWeight: number): number {
  return (a.hardProblems - b.hardProblems) * hardProblemWeight + (a.softRecommendations - b.softRecommendations);
}

/**
 * Proposes a better placement for the rooms already rooted on `level`.
 * Returns a full `Box[]` (every storey, same shape `boxes` came in as) --
 * only the boxes actually moved are new objects, everything else is the
 * same reference it came in as, so a caller diffing for a re-render sees
 * exactly what changed. Never worse than `boxes` itself: see the file
 * doc comment for why.
 */
export function generateLayout(
  boxes: Box[],
  level: number,
  storeys: number,
  arrows: Arrow[],
  autoCarve: boolean,
  boundary: Poly | null,
  facts: RoomFacts,
  rules?: RelationRow[],
  options: GenerateOptions = {},
): Box[] {
  const movableIds = liveBoxes(boxes, level)
    .filter((b) => b.level === level)
    .map((b) => b.id);
  if (movableIds.length === 0) return boxes;

  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const config = options.config ?? DEFAULT_SEARCH_CONFIG;
  const rng = mulberry32(options.seed ?? Date.now());
  const cooling = Math.pow(config.tEnd / config.tStart, 1 / Math.max(1, iterations));
  // Doors are not a separate, later step -- they're part of what makes a
  // candidate good or bad (reachability, required adjacency), so every
  // candidate is scored with its OWN doors, not the doors the arrangement
  // happened to start with. This storey's arrows are re-suggested fresh
  // against each candidate's actual geometry (`arrows.ts`'s own
  // `suggestArrows`, the same one-click "Suggest" a person uses by hand);
  // every other storey's doors are carried through unchanged.
  //
  // "Fresh" has to mean fresh, not "whatever was suggested once at the
  // start, plus new ones bolted on": `startingLevelArrows` can itself
  // already contain auto-suggested doors (`Arrow.targetId` set) computed
  // against the ARRANGEMENT THE SEARCH STARTED FROM, and once a move
  // separates a pair that used to touch, that stale entry does not
  // magically stop being true just because nobody removed it -- carrying
  // it into every later candidate's `candidateArrows` unconditionally
  // would score reachability and adjacency against a door set that no
  // longer matches the candidate's own geometry, exactly the "optimizing
  // around a picture that never changes" failure this design already
  // rejects for a *fixed* door set (see the file doc comment). A hand-
  // placed door never carries a `targetId` (`store.ts`'s `addArrow`/
  // `moveArrow` never set one, and clear it on a manual move) and an
  // exterior door never has one either, so filtering on it is exactly
  // "keep what a person or the caller actually placed, re-derive
  // everything `suggestArrows` itself produced" -- not a heuristic, the
  // same distinction `Arrow.targetId`'s own doc comment already draws.
  const otherLevelArrows = arrows.filter((a) => a.level !== level);
  const fixedLevelArrows = arrows.filter((a) => a.level === level && a.targetId === undefined);
  const score = (candidate: Box[]) => {
    const suggested = suggestArrows(liveBoxes(candidate, level), fixedLevelArrows, level, autoCarve);
    const candidateArrows = [...otherLevelArrows, ...fixedLevelArrows, ...suggested];
    return scoreCandidate(candidate, storeys, candidateArrows, autoCarve, facts, rules);
  };

  let current = boxes;
  let currentScore = score(current);
  let best = current;
  let bestScore = currentScore;

  let temperature = config.tStart;
  for (let iter = 0; iter < iterations; iter++) {
    const frac = temperature / config.tStart;
    const stepM = config.stepFloorM + config.stepScaleM * frac;
    const rotStepDeg = config.rotFloorDeg + config.rotScaleDeg * frac;
    const { candidate, touchedIds } = propose(current, movableIds, level, rng, stepM, rotStepDeg, config.moveWeights);
    if (passesCheapFilter(candidate, level, touchedIds, boundary)) {
      const candidateScore = score(candidate);
      const delta = combinedDelta(candidateScore, currentScore, config.hardProblemWeight);
      if (delta <= 0 || rng() < Math.exp(-delta / temperature)) {
        current = candidate;
        currentScore = candidateScore;
        if (compareScores(currentScore, bestScore) < 0) {
          best = current;
          bestScore = currentScore;
        }
      }
    }
    temperature *= cooling;
  }
  return best;
}

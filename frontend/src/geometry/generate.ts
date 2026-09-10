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
 * (nudge one room's position/rotation/size, or swap two rooms), not a
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
import { pointOnPolyBoundary, polyOfBox } from "./poly";
import { boxesTrulyIntersect } from "./rect";
import { compareScores, scoreCandidate, type RelationRow, type Score } from "./relationships";
import { liveBoxes } from "./snap";
import type { Arrow, Box, Point, Poly, PrivacyTier } from "./types";

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

export interface GenerateOptions {
  /** How many perturbations to try. More finds a better arrangement at
   * the cost of time; the default is tuned for a house-sized room count
   * (well under a second for a few dozen rooms). */
  iterations?: number;
  /** Fixed seed for a reproducible run. Omit for a fresh random search
   * each call. */
  seed?: number;
}

const DEFAULT_ITERATIONS = 600;
/** Where the annealing schedule starts and (asymptotically) ends --
 * chosen so a hard-problem difference (weight 1000, below) is very
 * unlikely to be accepted even at the start, while a small soft-
 * recommendation difference still can be, and by the final iteration
 * essentially nothing worse is ever accepted. */
const T_START = 3;
const T_END = 0.002;
/** How much one hard problem outweighs the entire soft-recommendation
 * total in the acceptance test -- large enough that no plausible soft
 * improvement ever makes accepting a worse hard-problem count look
 * attractive, matching `compareScores`' own "hard problems always decide
 * first." Only shapes the stochastic walk; the *returned* candidate is
 * never worse than the start regardless (see the file doc comment). */
const HARD_PROBLEM_WEIGHT = 1000;

type MoveKind = "translate" | "resize" | "rotate" | "swap";

/** `box`, nudged by one of four move kinds, sized to `stepM`/`rotStepDeg`
 * for translate/resize/rotate -- shrinking as the search cools -- and
 * always kept at or above its own `minWidth`/`minHeight` by construction,
 * never rejected for it afterwards. */
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

/** One perturbed candidate array, and which movable ids it touched (so
 * the cheap-reject step only re-checks those, not every live pair). */
function propose(
  current: Box[],
  movableIds: string[],
  rng: () => number,
  stepM: number,
  rotStepDeg: number,
): { candidate: Box[]; touchedIds: string[] } {
  const byId = new Map(current.map((b) => [b.id, b]));
  const kinds: MoveKind[] = ["translate", "resize", "rotate", "swap"];
  const kind = kinds[Math.floor(rng() * kinds.length)];
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

function combinedDelta(a: Score, b: Score): number {
  return (a.hardProblems - b.hardProblems) * HARD_PROBLEM_WEIGHT + (a.softRecommendations - b.softRecommendations);
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
  passableOf: (roomType: string) => boolean,
  tierOf: (roomType: string) => PrivacyTier | undefined,
  auxiliaryOf: (roomType: string) => boolean,
  circulationOf: (roomType: string) => boolean,
  rules?: RelationRow[],
  options: GenerateOptions = {},
): Box[] {
  const movableIds = liveBoxes(boxes, level)
    .filter((b) => b.level === level)
    .map((b) => b.id);
  if (movableIds.length === 0) return boxes;

  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const rng = mulberry32(options.seed ?? Date.now());
  const cooling = Math.pow(T_END / T_START, 1 / Math.max(1, iterations));
  const score = (candidate: Box[]) => scoreCandidate(candidate, storeys, arrows, autoCarve, passableOf, tierOf, auxiliaryOf, circulationOf, rules);

  let current = boxes;
  let currentScore = score(current);
  let best = current;
  let bestScore = currentScore;

  let temperature = T_START;
  for (let iter = 0; iter < iterations; iter++) {
    const frac = temperature / T_START;
    const stepM = 0.1 + 2.5 * frac;
    const rotStepDeg = 1 + 20 * frac;
    const { candidate, touchedIds } = propose(current, movableIds, rng, stepM, rotStepDeg);
    if (passesCheapFilter(candidate, level, touchedIds, boundary)) {
      const candidateScore = score(candidate);
      const delta = combinedDelta(candidateScore, currentScore);
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

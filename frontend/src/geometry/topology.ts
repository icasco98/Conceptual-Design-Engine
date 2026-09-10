/**
 * The topology and dimensioning stages: turning a flat room list into a
 * real starting arrangement that already reflects the adjacency rules,
 * instead of handing the search a shelf-packed row of boxes with a fixed
 * 0.3 m gap between every pair and zero notion of which rooms belong near
 * which. Batch 001's own report named this the actual blocker -- rooms
 * essentially never touch by chance, so almost nothing about adjacency or
 * doors is ever exercised. This file, plus `snap` as a search move
 * (`generate.ts`), is batch 002's fix.
 *
 * Two independent stages, in the order every real automated floor-plan
 * generator uses them (see GPLAN, arxiv 2008.01803, and the squarified-
 * treemap floor-plan literature): a *topology* stage first decides roughly
 * who should sit near whom -- a bubble diagram, laid out by a small,
 * hand-rolled force simulation (`layoutBubbles`) -- and only then a
 * *dimensioning* stage (`dimensionRooms`) turns those rough positions into
 * real, non-overlapping rectangles that fit the plot. Deliberately no
 * refinement here at all: `generateLayout`'s own simulated annealing is
 * still what polishes the result afterward, exactly as it already did for
 * the old shelf-packed start -- this file only replaces what the search
 * starts *from*, never how it searches.
 *
 * No ML, no trained model, nothing hidden: both stages are the same kind
 * of hand-rolled, deterministic, seedless math this project already uses
 * for its simulated-annealing search and its PRNG -- a textbook force-
 * directed graph layout (Fruchterman & Reingold, 1991) and a textbook
 * slice-and-dice area partition, not a novel algorithm and not a model
 * anyone has to trust rather than read.
 *
 * Batch 003 added three more forces/biases the bubble and dimensioning
 * stages didn't have, after diagnosing (see `reports/batch-003.html`) that
 * batch 002's own "rooms now touch" fix still left a real, if smaller,
 * gap between what the topology stage models and what the rule set
 * actually checks: extra repulsion between `undesired` pairs
 * (`buildUndesiredPairs`, Task 2 -- the generic repulsion above treats an
 * undesired pair exactly like any two unrelated rooms), a privacy-tier
 * bias toward/away from the entry point (`TopologyRoom.tier`/
 * `isEntryPoint`, Task 3), and a boundary-touch repair pass in
 * `dimensionRooms` for rooms that need a real exterior wall
 * (`TopologyRoom.needsExterior`, Task 4). All three are additive and
 * strictly optional on the `TopologyRoom` shape -- a caller (an existing
 * test, say) that never sets `tier`, `isEntryPoint` or `needsExterior`
 * gets exactly batch 002's behaviour back, unchanged.
 */
import type { RelationRow } from "./relationships";
import { ROOM_RELATIONSHIPS } from "./relationships";
import type { Point, PrivacyTier } from "./types";

/** What either stage needs to know about one room instance -- deliberately
 * not a `Box`: this file works before a room has a real rectangle, and
 * (same reasoning as `RoomFacts` in types.ts) stays independent of
 * `rooms.ts`'s own catalogue. The caller (`scenarios.ts`) is the one place
 * that knows how to turn a `roomType` into these numbers. */
export interface TopologyRoom {
  id: string;
  roomType: string;
  /** Its footprint's target area, m² -- typically `typicalWidth *
   * typicalHeight` from `rooms.ts`. Only ever used to size this room's own
   * "personal space" bubble and, in dimensioning, its share of the plot;
   * never compared against a real rectangle here. */
  targetAreaM2: number;
  minWidth: number;
  minHeight: number;
  /** `rooms.ts`'s own `tier` for this instance's room type -- `undefined`
   * for a type the gradient check exempts (a bathroom, a garage). Read
   * only by the topology stage's tier-gradient bias (Task 3, batch 003):
   * public-tier rooms are nudged toward the entry point, private-tier ones
   * away from it. A caller that never sets this (an existing test
   * constructing a bare `TopologyRoom`) gets no bias at all, the same as
   * before this field existed. */
  tier?: PrivacyTier;
  /** This is the room the rest of the bubble diagram orients itself
   * around -- normally the one instance of `entry` a program has. At most
   * one room should set this; if more than one does, the last one found
   * wins and nothing crashes over it, but the caller (`scenarios.ts`) only
   * ever sets it on the actual entry. */
  isEntryPoint?: boolean;
  /** Needs a real exterior wall to be a usable room at all -- `rooms.ts`'s
   * `sleeping` fact (a bedroom, a driver's or nanny's room), handed in by
   * the caller the same way every other room-type fact reaches this file:
   * as a plain value on the instance, not a lookup this file performs
   * itself. Read only by `dimensionRooms`'s boundary-repair pass (Task 4,
   * batch 003). */
  needsExterior?: boolean;
}

/** One room's position and "personal space" after the topology stage --
 * a rough centre and radius, not a rectangle. `roomType` rides along only
 * so a caller can render or reason about the bubble diagram without a
 * second lookup. */
export interface BubbleNode {
  id: string;
  roomType: string;
  x: number;
  y: number;
  radius: number;
}

/** A room's real, dimensioned rectangle -- the actual output of this
 * file, in the same left/top/width/height shape `Box` uses so a caller
 * can drop these straight into one. */
export interface PlacedRoom {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A room's footprint approximated as a circle of the same area -- what
 * "personal space" means for the bubble stage: two rooms whose circles
 * don't overlap are assumed to have enough room to become real,
 * non-overlapping rectangles later. */
function radiusFor(areaM2: number): number {
  return Math.sqrt(Math.max(areaM2, 0.01) / Math.PI);
}

/** Extra clearance kept between two bubbles' circles on top of their own
 * radii -- rectangles have corners a circle doesn't, so a little slack
 * here means the dimensioning stage is rarely fighting the space the
 * topology stage left it. */
const BUBBLE_PADDING_M = 0.4;

/** How much stronger the repulsion between an `undesired` pair is than
 * the generic term every pair already gets (Task 2, batch 003) -- e.g.
 * `2.5` means an undesired pair feels 3.5x a normal pair's separation
 * force (the generic 1x plus this 2.5x extra), which is enough to reliably
 * settle them farther apart than an unrelated pair of the same sizes
 * (`topology.test.ts`'s own test for this) without so overwhelming the
 * simulation that a genuinely small plot can no longer settle at all --
 * chosen empirically against that test and the scenario suite (see
 * `reports/batch-003.html`), not derived from anything physical. */
const UNDESIRED_REPULSION_BOOST = 2.5;

/** The spring constant for the privacy-tier bias toward/away from the
 * entry point (Task 3, batch 003) -- multiplied by a room's own current
 * distance from the entry each iteration, so it scales with how far off a
 * room already is rather than applying one fixed push regardless of
 * position. Kept modest relative to `BUBBLE_PADDING_M`-scaled repulsion
 * and attraction forces so the tier bias nudges the settle rather than
 * overriding what adjacency already decided -- a kitchen (private tier)
 * required to sit next to the dining room (semi-public, unbiased) should
 * still end up there even though the bias alone would pull it away from
 * the entry. */
const TIER_BIAS_STRENGTH = 0.12;

/**
 * `rooms`, one instance-to-instance edge per `required`/`desired` row in
 * `rules` whose two types both actually appear in `rooms` -- `undesired`
 * rows are not modelled here at all (this stage only pulls things
 * together; keeping conflicting pairs apart is left to the search and its
 * existing scoring, exactly as it already was for the old shelf-packed
 * start).
 *
 * A row is type-level (`relationships.ts`'s own convention -- "at least
 * one instance satisfies it"), so with more than one instance of a type on
 * either side this pairs them by cycling the shorter list rather than
 * connecting every instance to every instance: three bedrooms and three
 * bathrooms become a clean one-to-one, but three bedrooms and one bathroom
 * all still get a real edge (to the one bathroom there is) instead of
 * either all-to-all clustering everything into one clump or only the
 * first bedroom ever being connected. Nothing here knows or cares which
 * bedroom is "really" whose -- same as the checker this feeds into, which
 * only asks whether *some* instance satisfies the row unless a caller
 * sets `Box.attachedTo`.
 */
function buildEdges(rooms: TopologyRoom[], rules: RelationRow[]): { a: number; b: number; strength: number }[] {
  const byType = new Map<string, number[]>();
  rooms.forEach((r, i) => {
    const list = byType.get(r.roomType);
    if (list) list.push(i);
    else byType.set(r.roomType, [i]);
  });

  const edges: { a: number; b: number; strength: number }[] = [];
  for (const row of rules) {
    if (row.relation === "undesired") continue;
    const as = byType.get(row.a);
    const bs = byType.get(row.b);
    if (!as?.length || !bs?.length) continue;
    // A row can list the same type on both sides in principle; guard
    // against ever pairing an instance with itself rather than assume it
    // can't happen.
    const strength = row.relation === "required" ? 1 : 0.4;
    const n = Math.max(as.length, bs.length);
    for (let i = 0; i < n; i++) {
      const a = as[i % as.length];
      const b = bs[i % bs.length];
      if (a === b) continue;
      edges.push({ a, b, strength });
    }
  }
  return edges;
}

/**
 * Every instance-to-instance pair whose types are marked `undesired` in
 * `rules` -- unlike `buildEdges`' required/desired pairing, this is a full
 * cross product of the two types' instances, not a cycled one-to-one:
 * `checkAdjacency`'s own undesired check fails the whole row the moment
 * *any* instance of one type touches *any* instance of the other, so
 * keeping only one representative pair apart (the way one bedroom can
 * stand in for "the bedroom" in a required row) would leave every other
 * bedroom free to end up against the kitchen anyway. Three bedrooms and
 * one kitchen means three pairs kept apart, not one.
 *
 * Order-independent and de-duplicated (`a < b`), since a pair pushed apart
 * twice is no different from once -- just double the force for no reason.
 */
function buildUndesiredPairs(rooms: TopologyRoom[], rules: RelationRow[]): { a: number; b: number }[] {
  const byType = new Map<string, number[]>();
  rooms.forEach((r, i) => {
    const list = byType.get(r.roomType);
    if (list) list.push(i);
    else byType.set(r.roomType, [i]);
  });

  const pairs: { a: number; b: number }[] = [];
  const seen = new Set<string>();
  for (const row of rules) {
    if (row.relation !== "undesired") continue;
    const as = byType.get(row.a);
    const bs = byType.get(row.b);
    if (!as?.length || !bs?.length) continue;
    for (const a of as) {
      for (const b of bs) {
        if (a === b) continue;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const key = `${lo}|${hi}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ a: lo, b: hi });
      }
    }
  }
  return pairs;
}

/** The unit vector from a point `[dx, dy]` apart, and the distance it was
 * built from -- shared by every force in `layoutBubbles` that needs one.
 * Two points closer than `1e-6` (shouldn't happen off the spiral start,
 * but never divide by zero over it) get a deterministic tie-break
 * direction from `seed` instead of an undefined one -- an arbitrary
 * irrational-ish angle spread, not random, so the whole simulation stays
 * seedless and reproducible. */
function safeDirection(dx: number, dy: number, seed: number): { ux: number; uy: number; d: number } {
  let d = Math.hypot(dx, dy);
  if (d < 1e-6) {
    const a = seed * 2.399963;
    dx = Math.cos(a);
    dy = Math.sin(a);
    d = 1;
  }
  return { ux: dx / d, uy: dy / d, d };
}

/** Deterministic, RNG-free starting positions -- a Fibonacci/sunflower
 * spiral, which spaces `n` points out with no two ever exactly coincident
 * and no seed to manage. `scale` is picked from the rooms' own average
 * radius so the initial spread is already roughly the right order of
 * magnitude for their sizes, which means fewer iterations are spent just
 * undoing a bad start. */
function spiralStart(nodes: { radius: number }[]): Point[] {
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  const avgRadius = nodes.reduce((s, n) => s + n.radius, 0) / Math.max(1, nodes.length);
  const scale = (avgRadius + BUBBLE_PADDING_M) * 1.8;
  return nodes.map((_, i) => {
    const r = scale * Math.sqrt(i + 0.5);
    const a = i * GOLDEN_ANGLE;
    return [r * Math.cos(a), r * Math.sin(a)] as Point;
  });
}

export interface LayoutBubblesOptions {
  /** Upper bound on iterations -- the simulation also stops early once
   * movement has settled (see `STOP_THRESHOLD_M` below), so this mostly
   * bounds the worst case for a graph that never quite settles. */
  iterations?: number;
}

const DEFAULT_BUBBLE_ITERATIONS = 300;
/** Below this average per-node displacement in one iteration, the layout
 * is considered settled and the simulation stops early. */
const STOP_THRESHOLD_M = 0.002;
/** However small the cooling temperature gets, a floor keeps the very
 * last iterations from doing precisely nothing -- not load-bearing for
 * correctness, only for not wasting the tail of the iteration budget. */
const MIN_TEMP_M = 0.01;

/**
 * The topology stage: a small force simulation over `rooms` and the
 * `required`/`desired` rows of `rules` that apply to them, settling on one
 * rough centre per room -- a bubble diagram, not real rectangles.
 *
 * The physics, adapted from Fruchterman & Reingold (1991) -- a textbook
 * force-directed graph layout, chosen because it is simple, well
 * understood, and needs nothing but pairwise distances:
 *
 * - Repulsion between *every* pair, so nothing ends up on top of anything:
 *   magnitude `k² / d` along the line between them, where `k` is that
 *   pair's own combined radius plus padding rather than one global
 *   constant -- two large rooms need more space between their centres
 *   than two small ones, and a fixed `k` can't know that.
 * - Attraction along each edge from `buildEdges`, but only once the pair
 *   is further apart than their two radii combined (i.e. once they'd no
 *   longer be touching circles) -- pulling two already-touching bubbles
 *   still closer would just fight the repulsion term for no reason, since
 *   "touching" is already the goal.
 * - A cooling "temperature" caps how far any node may move in one
 *   iteration and shrinks linearly toward `MIN_TEMP_M` -- what makes the
 *   simulation settle rather than oscillate forever, and what "iterate
 *   until it settles" below actually detects.
 *
 * Deterministic: `spiralStart` needs no seed, and neither does anything
 * after it -- same room list in, same centres out, always.
 */
export function layoutBubbles(rooms: TopologyRoom[], rules: RelationRow[] = ROOM_RELATIONSHIPS, options: LayoutBubblesOptions = {}): BubbleNode[] {
  const n = rooms.length;
  if (n === 0) return [];
  const radii = rooms.map((r) => radiusFor(r.targetAreaM2));
  if (n === 1) return [{ id: rooms[0].id, roomType: rooms[0].roomType, x: 0, y: 0, radius: radii[0] }];

  const positions = spiralStart(radii.map((radius) => ({ radius })));
  const edges = buildEdges(rooms, rules);
  const undesiredPairs = buildUndesiredPairs(rooms, rules);
  const entryIndex = rooms.findIndex((r) => r.isEntryPoint);
  const iterations = options.iterations ?? DEFAULT_BUBBLE_ITERATIONS;
  const avgRadius = radii.reduce((s, r) => s + r, 0) / n;
  let temperature = Math.max(MIN_TEMP_M, avgRadius);
  const cooling = (temperature - MIN_TEMP_M) / Math.max(1, iterations);

  for (let iter = 0; iter < iterations; iter++) {
    const fx = new Array<number>(n).fill(0);
    const fy = new Array<number>(n).fill(0);

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const { ux, uy, d } = safeDirection(positions[i][0] - positions[j][0], positions[i][1] - positions[j][1], i - j);
        const k = radii[i] + radii[j] + BUBBLE_PADDING_M;
        const repel = (k * k) / d;
        fx[i] += ux * repel;
        fy[i] += uy * repel;
        fx[j] -= ux * repel;
        fy[j] -= uy * repel;
      }
    }

    for (const edge of edges) {
      let dx = positions[edge.b][0] - positions[edge.a][0];
      let dy = positions[edge.b][1] - positions[edge.a][1];
      const d = Math.max(1e-6, Math.hypot(dx, dy));
      const rest = radii[edge.a] + radii[edge.b];
      const stretch = d - rest;
      if (stretch <= 0) continue; // already touching or closer -- repulsion owns this, not attraction
      const ux = dx / d;
      const uy = dy / d;
      const pull = stretch * edge.strength;
      fx[edge.a] += ux * pull;
      fy[edge.a] += uy * pull;
      fx[edge.b] -= ux * pull;
      fy[edge.b] -= uy * pull;
    }

    // Task 2 (batch 003): an undesired pair gets extra repulsion on top of
    // the generic term every pair already got above -- the generic term
    // alone treats an undesired pair exactly like any two unconnected
    // rooms of the same size, which is what left batch 002's own bubble
    // stage with nothing actively keeping a bedroom away from a kitchen.
    // Same `k²/d` shape as the generic repulsion, scaled up, so it stays
    // one physically consistent kind of force rather than a bolted-on
    // special case.
    for (const pair of undesiredPairs) {
      const { ux, uy, d } = safeDirection(positions[pair.a][0] - positions[pair.b][0], positions[pair.a][1] - positions[pair.b][1], pair.a + pair.b * 97 + 1);
      const k = radii[pair.a] + radii[pair.b] + BUBBLE_PADDING_M;
      const repel = ((k * k) / d) * UNDESIRED_REPULSION_BOOST;
      fx[pair.a] += ux * repel;
      fy[pair.a] += uy * repel;
      fx[pair.b] -= ux * repel;
      fy[pair.b] -= uy * repel;
    }

    // Task 3 (batch 003): bias by privacy tier toward or away from the
    // entry point -- public rooms pulled toward it, private rooms pushed
    // away, both as a spring proportional to the current distance so the
    // bias scales naturally with how far off a room already is rather
    // than applying one fixed nudge regardless of position. Semi-public
    // and tier-exempt rooms (`tier === undefined` -- a bathroom, a garage)
    // get no bias either way: the gradient the tier check actually cares
    // about is public-vs-private, and there is no single "correct"
    // direction for a room the check itself never judges. Skipped
    // entirely when no room declares itself the entry point (an existing
    // caller building a bare `TopologyRoom` list, or a program with no
    // `entry` at all) -- there is nothing to bias toward or away from.
    if (entryIndex !== -1) {
      const anchor = positions[entryIndex];
      for (let i = 0; i < n; i++) {
        if (i === entryIndex) continue;
        const tier = rooms[i].tier;
        if (tier !== "public" && tier !== "private") continue;
        const { ux, uy, d } = safeDirection(positions[i][0] - anchor[0], positions[i][1] - anchor[1], i + 500);
        const bias = (tier === "public" ? -TIER_BIAS_STRENGTH : TIER_BIAS_STRENGTH) * d;
        fx[i] += ux * bias;
        fy[i] += uy * bias;
      }
    }

    let totalMove = 0;
    for (let i = 0; i < n; i++) {
      const mag = Math.hypot(fx[i], fy[i]);
      const step = mag < 1e-9 ? 0 : Math.min(mag, temperature) / mag;
      const dx = fx[i] * step;
      const dy = fy[i] * step;
      positions[i] = [positions[i][0] + dx, positions[i][1] + dy];
      totalMove += Math.hypot(dx, dy);
    }
    temperature = Math.max(MIN_TEMP_M, temperature - cooling);
    if (totalMove / n < STOP_THRESHOLD_M) break;
  }

  return rooms.map((room, i) => ({ id: room.id, roomType: room.roomType, x: positions[i][0], y: positions[i][1], radius: radii[i] }));
}

/** A path through every bubble, greedily visiting the nearest
 * not-yet-visited one each step -- turns the topology stage's *positions*
 * into an *order*, which is what a slice-and-dice partition actually
 * consumes (it only ever knows "this room comes before that one in the
 * list", never x/y directly). Starting from index 0 rather than, say, the
 * corner nearest the plot's own origin: the order only has to keep
 * spatial neighbours adjacent in the list, and where the path happens to
 * start doesn't change that. O(n²), fine for a house-sized room count. */
function nearestNeighborOrder(nodes: BubbleNode[]): number[] {
  const n = nodes.length;
  if (n <= 2) return nodes.map((_, i) => i);
  const visited = new Array<boolean>(n).fill(false);
  const order = [0];
  visited[0] = true;
  for (let step = 1; step < n; step++) {
    const last = nodes[order[order.length - 1]];
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      if (visited[i]) continue;
      const d = Math.hypot(nodes[i].x - last.x, nodes[i].y - last.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    order.push(best);
    visited[best] = true;
  }
  return order;
}

/** The weight a slice-and-dice split allocates a room by -- its target
 * area, floored at its own minimum footprint. Flooring it there (rather
 * than using the raw target area) is what makes the partition actually
 * try to give a small-but-strict-minimum room enough of a share to meet
 * its own `minWidth`/`minHeight`, in the common case where the plot has
 * enough total area to go around (`scenarios.evaluator.ts`'s own
 * `isFeasible` is exactly that promise at the whole-program level). It is
 * a bias on the split, not a guarantee: see `dimensionRooms`'s own doc
 * comment for why this stage never forces a minimum past what a clean
 * partition can give it. */
function splitWeight(room: TopologyRoom): number {
  return Math.max(room.targetAreaM2, room.minWidth * room.minHeight);
}

/**
 * Recursively slices `rect` between the rooms named by `order[from..to)`,
 * proportional to `splitWeight`, always cutting along whichever of the
 * rectangle's own two sides is currently longer -- which is what keeps
 * the resulting rectangles from all turning into slivers the way cutting
 * the same axis every level down would. Every recursive call's two
 * children exactly tile its own rectangle with no gap and no overlap by
 * construction (`w1 + w2 === rect.width` or `h1 + h2 === rect.height`
 * always, floating point aside), so the whole partition is non-
 * overlapping and boundary-respecting *by construction*, not by anything
 * checked afterward -- deliberately: a corrective pass that grew an
 * undersized room back up to its minimum could only ever do so by eating
 * into a neighbour's own rectangle, which is exactly the overlap this
 * function exists to never produce. A room whose minimum genuinely can't
 * fit in the share this gives it is left undersized rather than forced --
 * the same "flagged, never forced" rule the interactive editor's own plot
 * boundary already keeps (HANDOFF.md) -- and in practice self-corrects:
 * `generateLayout`'s own `resize` move floors at `minWidth`/`minHeight`
 * on its very first successful touch of that room.
 */
function slice(order: number[], from: number, to: number, rooms: TopologyRoom[], rect: Rect, out: Map<string, Rect>): void {
  const count = to - from;
  if (count <= 0) return;
  if (count === 1) {
    out.set(rooms[order[from]].id, rect);
    return;
  }

  const weights = order.slice(from, to).map((i) => splitWeight(rooms[i]));
  const total = weights.reduce((s, w) => s + w, 0);
  // A contiguous prefix/suffix split (never reordering `order` itself) is
  // what keeps `nearestNeighborOrder`'s own spatial-locality promise
  // intact through every level of recursion: two rooms adjacent in the
  // list stay in the same half, or end up either side of one cut, never
  // scattered to opposite corners by an unrelated regrouping.
  let cumulative = 0;
  let splitAt = 1; // index within [from, to), at least 1 and at most count-1 so both sides are non-empty
  for (let i = 0; i < count; i++) {
    cumulative += weights[i];
    if (cumulative >= total / 2) {
      splitAt = Math.min(count - 1, Math.max(1, i + 1));
      break;
    }
  }
  const weightA = weights.slice(0, splitAt).reduce((s, w) => s + w, 0);
  const fracA = total > 0 ? weightA / total : splitAt / count;

  let rectA: Rect;
  let rectB: Rect;
  if (rect.width >= rect.height) {
    const widthA = rect.width * fracA;
    rectA = { left: rect.left, top: rect.top, width: widthA, height: rect.height };
    rectB = { left: rect.left + widthA, top: rect.top, width: rect.width - widthA, height: rect.height };
  } else {
    const heightA = rect.height * fracA;
    rectA = { left: rect.left, top: rect.top, width: rect.width, height: heightA };
    rectB = { left: rect.left, top: rect.top + heightA, width: rect.width, height: rect.height - heightA };
  }
  slice(order, from, from + splitAt, rooms, rectA, out);
  slice(order, from + splitAt, to, rooms, rectB, out);
}

/** Within this, a rectangle's own edge and the plot boundary's
 * corresponding edge are the same line -- floating point from repeated
 * fraction splits, not a real gap; the same order of tolerance
 * `EDGE_TOL_M` (habitability.ts) uses for the analogous "is this the same
 * wall" question. */
const BOUNDARY_TOUCH_TOL_M = 0.01;

/** Whether any of `rect`'s four sides sits on `boundary`'s own matching
 * side -- computed directly from the two rectangles' coordinates, not
 * from split history. This is exact for a slice-and-dice partition
 * specifically because every recursive cut in `slice` either preserves a
 * side unchanged from its parent or replaces it with a brand-new internal
 * cut strictly inside the parent's own extent (see `slice`'s own doc
 * comment on why the partition tiles `boundary` exactly) -- so a leaf
 * rectangle's side can only ever equal the *original* boundary's
 * coordinate by having been preserved all the way down, never by
 * coincidentally landing on the same number some other way. */
function touchesBoundary(rect: Rect, boundary: Rect): boolean {
  return (
    Math.abs(rect.left - boundary.left) <= BOUNDARY_TOUCH_TOL_M ||
    Math.abs(rect.top - boundary.top) <= BOUNDARY_TOUCH_TOL_M ||
    Math.abs(rect.left + rect.width - (boundary.left + boundary.width)) <= BOUNDARY_TOUCH_TOL_M ||
    Math.abs(rect.top + rect.height - (boundary.top + boundary.height)) <= BOUNDARY_TOUCH_TOL_M
  );
}

/**
 * The dimensioning stage's boundary-repair pass (Task 4, batch 003):
 * swaps rectangle *assignments* (never rectangles themselves, so the
 * partition `slice` already built stays exactly as non-overlapping and
 * boundary-respecting as it was) so that a room needing a real exterior
 * wall (`TopologyRoom.needsExterior` -- `rooms.ts`'s `sleeping` fact, a
 * bedroom, a driver's or nanny's room) ends up in a slice that actually
 * touches the plot boundary, whenever some other, non-needing room
 * currently holds one and can be swapped for it.
 *
 * Deliberately a swap, not a re-partition: `slice`'s own weight-ordered
 * recursion is what guarantees the tiling never overlaps and never spills
 * past `boundary`, and re-deriving that guarantee for a boundary-aware
 * variant of the recursion itself is exactly the risk Task 5's own
 * write-up in `reports/batch-003.html` declines to take for the
 * squarified treemap. Swapping which room-id points at which
 * already-computed `Rect` sidesteps that risk completely -- the set of
 * rectangles in `out` never changes, only the mapping from id to
 * rectangle does, so whatever was true of the partition before this runs
 * (exact tiling, no overlap) is still true after it, unconditionally.
 *
 * Greedy, and bounded to at most one swap per needing room: for each room
 * that needs an exterior wall and isn't currently on one, pick whichever
 * available non-needing, boundary-touching room's rectangle is closest in
 * area to what this room actually wants (`splitWeight`, the same measure
 * `slice` itself allocates by) and trade with it. Closest-by-area rather
 * than first-found: a bedroom trading into a closet-sized corner slice
 * would trade an unmet exterior wall for a room now far under its own
 * minimum, which `generateLayout`'s own resize move has to fight uphill
 * against every neighbour instead of just growing into slack. Some
 * needing rooms may still end up without one -- a program with more
 * bedrooms than the plot has perimeter to give them is a real fact about
 * the program, not something a rectangle-swap can invent its way out of;
 * same "flagged, never forced" shape as everywhere else in this file.
 */
function repairBoundaryAssignment(rooms: TopologyRoom[], boundary: Rect, out: Map<string, Rect>): void {
  const touching = new Set(rooms.filter((r) => touchesBoundary(out.get(r.id)!, boundary)).map((r) => r.id));
  for (const room of rooms) {
    if (!room.needsExterior || touching.has(room.id)) continue;
    let bestId: string | null = null;
    let bestGap = Infinity;
    const wanted = splitWeight(room);
    for (const other of rooms) {
      if (other.id === room.id || other.needsExterior || !touching.has(other.id)) continue;
      const rect = out.get(other.id)!;
      const gap = Math.abs(rect.width * rect.height - wanted);
      if (gap < bestGap) {
        bestGap = gap;
        bestId = other.id;
      }
    }
    if (bestId === null) continue; // nothing available to trade with -- left unmet, not forced
    const mine = out.get(room.id)!;
    const theirs = out.get(bestId)!;
    out.set(room.id, theirs);
    out.set(bestId, mine);
    touching.delete(bestId);
    touching.add(room.id);
  }
}

/**
 * The dimensioning stage: `rooms` and the rough centres `layoutBubbles`
 * found for them, turned into real rectangles that exactly tile
 * `boundary` -- a slice-and-dice area partition (Shneiderman's original
 * treemap, not the squarified variant: see the file doc comment on why
 * the simpler one was kept), ordered by `nearestNeighborOrder` so rooms
 * the topology stage placed near each other tend to land in neighbouring
 * slices rather than opposite corners of the plot, then repaired
 * (`repairBoundaryAssignment`, Task 4 batch 003) so a room that needs a
 * real exterior wall preferentially ends up on one.
 *
 * `bubbles` must carry the same ids as `rooms` (in any order) -- normally
 * whatever `layoutBubbles` just returned for this exact room list.
 */
export function dimensionRooms(rooms: TopologyRoom[], bubbles: BubbleNode[], boundary: Rect): PlacedRoom[] {
  if (rooms.length === 0) return [];
  const bubbleById = new Map(bubbles.map((b) => [b.id, b]));
  // Aligned 1:1 with `rooms` by index, so `nearestNeighborOrder`'s
  // returned indices need no second lookup back into `rooms`. A room
  // `layoutBubbles` was never given a position for (a caller passing
  // mismatched lists) still gets a real rectangle -- a synthetic bubble
  // at the origin -- rather than the whole stage throwing over one
  // missing entry.
  const nodes: BubbleNode[] = rooms.map((r) => bubbleById.get(r.id) ?? { id: r.id, roomType: r.roomType, x: 0, y: 0, radius: radiusFor(r.targetAreaM2) });
  const order = nearestNeighborOrder(nodes);

  const out = new Map<string, Rect>();
  slice(order, 0, order.length, rooms, boundary, out);
  repairBoundaryAssignment(rooms, boundary, out);
  return rooms.map((r) => {
    const rect = out.get(r.id)!;
    return { id: r.id, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  });
}

/** Both stages run back to back -- the one entry point `scenarios.ts`
 * actually calls: bubble layout, then the area partition, using the same
 * room list and the same default rule set unless a caller overrides it. */
export function topologyLayout(rooms: TopologyRoom[], boundary: Rect, rules: RelationRow[] = ROOM_RELATIONSHIPS): PlacedRoom[] {
  const bubbles = layoutBubbles(rooms, rules);
  return dimensionRooms(rooms, bubbles, boundary);
}

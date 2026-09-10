/**
 * Three checks, kept as three independent functions rather than merged
 * into one, because they answer three different questions and none of
 * them implies the others -- `checkAdjacency` (a room-type adjacency
 * table, sourced where it could be, see each row's comment, and marked
 * provisional where it could not, per Task 2), `tierViolations`, and
 * `stairConnectionProblems`:
 *
 * `checkAdjacency` asks whether the *right* rooms ended up near each
 * other -- and the three relations mean three different things by
 * "near," not one physical fact checked three ways:
 *
 * - `undesired` is physical adjacency, full stop (a shared wall, via
 *   `circulation.ts`'s own touch graph). A garage's noise and heat cross
 *   a wall whether or not a door was ever cut into it, so a touching
 *   pair is the problem regardless of doors.
 * - `required` means a direct door: `circulation.ts`'s own door graph
 *   (the same one `reachabilityProblems` and `tierViolations` already
 *   use), not the touch graph -- two rooms can share a wall and still
 *   fail a required row if nobody ever put a door in it. The whole
 *   reason kitchen-dining adjacency is required is so people can walk
 *   quickly between them; a wall with no door achieves that no better
 *   than not being adjacent at all.
 * - `desired` means *easy access*, which is a weaker and different claim
 *   than either of the above: not touching, not necessarily a direct
 *   door, but a short walk -- at most `EASY_ACCESS_HOPS` doors
 *   (`circulation.ts`'s `minHopCount`, an unweighted hop count over that
 *   same door graph, not `shortestPath`'s meter-weighted one, which
 *   answers a different question and would let one large room in the
 *   way count as "farther" than two small ones). Kitchen and laundry
 *   don't need to touch; a hallway between them is fine.
 *
 * Required is checked at the *type* level by default -- "does at least
 * one instance of each type connect" -- which is right for a type that
 * normally has one instance (an Entry, a Kitchen) but is not enough once
 * a type can legitimately appear more than once with each instance
 * needing its own separate attachment: two ensuite bathrooms off one
 * primary suite ("his" and "hers"), say. "At least one connects" would
 * report success even if only one of the two actually does, silently
 * covering for the other. `Box.attachedTo` is how an instance declares
 * which one it is required to connect to; when it does, that specific
 * claim is checked on its own, against the door graph, and failing it
 * fails the row regardless of what some other, untagged instance
 * satisfies. An instance that never declares an owner is judged exactly
 * as it always was.
 *
 * `tierViolations` asks whether a *door* respects the public-to-private
 * gradient (rooms.ts's `tier`): a door may connect adjacent tiers but
 * never skip one. This is about actual doors, not mere adjacency -- two
 * zones can share a wall with no door at all, which is `circulation.ts`'s
 * question, not this one.
 *
 * `stairConnectionProblems` asks a narrower question the gradient check
 * cannot: not "does this door skip a tier" (Stair-Bedroom is adjacent
 * tiers, which is normally fine -- that's what a Hallway-Bedroom door
 * is) but "did a stair's door land on another circulation space at all."
 * A stair serves every room on the floors it reaches, not just one; a
 * stair opening straight into a specific bedroom or kitchen makes that
 * room an involuntary through-route for everyone using the stairs.
 *
 * `collectFindings`, at the bottom, ties this file's checks,
 * `circulation.ts`'s `reachabilityProblems` and `efficiency.ts`'s
 * `unnecessaryGaps`/`circulationRatio` into the one call a consumer
 * needs -- but it hands back raw, structured results only (room ids,
 * tiers, relation kinds), no wording and no UI. Turning that into
 * something a person reads (icons, plain-language sentences, a panel) is
 * deliberately a separate step: this file's job stops at making the
 * findings computable, not at deciding how they look.
 *
 * `unnecessaryGaps`, `circulationRatio`, `overhangs` and `corridorWaste`
 * (efficiency.ts) are a different *kind* of finding from the four above,
 * not just more of the same: those four ask "does this work" (a real
 * requirement unmet, a real conflict, a door that skips a tier, a stair
 * that serves one room instead of everyone using it); these four ask "is
 * this wasting money" (an unclosed gap trading a shared wall for two
 * exterior ones, a hallway eating more of the floor than it needs to, a
 * wall jogging past a neighbour, a corridor built longer than its own
 * doors need). A house with any of these still works -- so all four are
 * always soft recommendations, `adjacencySeverity`'s `desired` in
 * spirit, never hard problems, whatever else is true of the plan.
 *
 * `deadEndHallways` (efficiency.ts, also) is the one exception to that:
 * a corridor that is the *sole* route between part of the plan and every
 * exterior door, more than a real code limit away, is a life-safety
 * defect, not a cost -- it joins the hard problems above, not the four
 * soft findings just above it. See its own doc comment for the reasoning.
 *
 * All of these are read-only diagnostics. None of them ever moves, resizes or
 * auto-connects anything -- same "flag, never force" rule as the rest of
 * this tool.
 */
import { minHopCount, reachabilityProblems, type ReachabilityProblem } from "./circulation";
import { buildCirculationGraphMemo, levelTouchDataMemo } from "./memo";
import {
  circulationRatio,
  corridorWaste,
  deadEndHallways,
  overhangs,
  unnecessaryGaps,
  CIRCULATION_RATIO_THRESHOLD,
  CORRIDOR_STUB_THRESHOLD_M,
  DEAD_END_LIMIT_M,
  GAP_THRESHOLD_M,
  OVERHANG_THRESHOLD_M,
  TOUCHING_TOL_M,
  type CirculationRatioFinding,
  type CorridorWasteFinding,
  type DeadEndFinding,
  type GapFinding,
  type OverhangFinding,
} from "./efficiency";
import { liveBoxes } from "./snap";
import type { Arrow, Box, PrivacyTier } from "./types";

export type Relation = "required" | "desired" | "undesired";

export interface RelationRow {
  a: string;
  b: string;
  relation: Relation;
}

/**
 * Room-type pairs only -- never a specific instance. The one deliberate
 * exception in the whole design (a dual-use dining room opened to a
 * diwaniya) is *not* a row here: it is scoped to that one instance via
 * `Box.privacyTierOverride`, not a type-level default that would apply to
 * every dining room in every house. Pairs not listed are neutral -- no
 * claim either way, not a missing relationship.
 *
 * Split into two tiers rather than one flat list: `BASE_ROOM_RELATIONSHIPS`
 * is general, sourced-or-defensible rows that apply to any household (a
 * kitchen belongs near its dining room, an office wants distance from
 * service noise); `CULTURAL_ROOM_RELATIONSHIPS` is this specific
 * household's own conventions (a diwaniya's isolation, a driver's or
 * nanny's staff-quarters logic, a reception room's own gender/guest
 * norms) -- real and sourced where the original comments say so, but not
 * universal the way the base rows are. Every existing caller that doesn't
 * pass its own `rules` list gets exactly today's behavior: `checkAdjacency`
 * and friends default to `ROOM_RELATIONSHIPS`, the two tiers combined. A
 * future project can instead pass `[...BASE_ROOM_RELATIONSHIPS, ...myOwnOverlay]`
 * to swap the cultural tier for its own without touching the sourced base.
 */
export const BASE_ROOM_RELATIONSHIPS: RelationRow[] = [
  // -- Sourced (Carolyn Matthews, "Adjacency Matrix Decoded") --
  { a: "kitchen", b: "dining_room", relation: "required" },
  { a: "kitchen", b: "laundry", relation: "desired" },
  { a: "mudroom", b: "laundry", relation: "desired" },
  { a: "bedroom", b: "bathroom", relation: "desired" },
  { a: "bedroom", b: "garage_single", relation: "undesired" },
  { a: "bedroom", b: "garage_double", relation: "undesired" },
  { a: "master_bedroom", b: "garage_single", relation: "undesired" },
  { a: "master_bedroom", b: "garage_double", relation: "undesired" },
  // -- Provisional: defensible, not directly cited -- flag for Step 6 --
  { a: "master_bedroom", b: "bathroom", relation: "required" },
  { a: "entry", b: "hallway", relation: "required" },
  { a: "garage_single", b: "mudroom", relation: "desired" },
  { a: "garage_double", b: "mudroom", relation: "desired" },
  { a: "garage_single", b: "entry", relation: "desired" },
  { a: "garage_double", b: "entry", relation: "desired" },
  { a: "bedroom", b: "kitchen", relation: "undesired" },
  { a: "master_bedroom", b: "kitchen", relation: "undesired" },
  // -- Sourced (generic principle: a quiet office kept from noisy/service space) --
  { a: "office", b: "kitchen", relation: "undesired" },
  { a: "office", b: "laundry", relation: "undesired" },
  { a: "office", b: "garage_single", relation: "undesired" },
  { a: "office", b: "garage_double", relation: "undesired" },
];

export const CULTURAL_ROOM_RELATIONSHIPS: RelationRow[] = [
  // -- Sourced (threshold-zone / Islamic-Arab domestic architecture lit.) --
  { a: "diwaniya", b: "bedroom", relation: "undesired" },
  { a: "diwaniya", b: "master_bedroom", relation: "undesired" },
  // -- Sourced (Al-Razouki, "The Diwaniya: A Uniquely Kuwaiti Institution") --
  { a: "driver_room", b: "diwaniya", relation: "desired" },
  // -- User-specified (this household's own layout logic) --
  { a: "diwaniya", b: "entry", relation: "undesired" },
  { a: "reception", b: "entry", relation: "required" },
  { a: "nanny_room", b: "kitchen", relation: "desired" }, // either/or with laundry -- see file doc
  { a: "nanny_room", b: "laundry", relation: "desired" }, // either/or with kitchen -- see file doc
  { a: "nanny_room", b: "bedroom", relation: "desired" },
  // -- Provisional: defensible, not directly cited -- flag for Step 6 --
  { a: "driver_room", b: "driver_bathroom", relation: "required" },
  { a: "nanny_room", b: "nanny_bathroom", relation: "required" },
  { a: "driver_room", b: "garage_single", relation: "desired" },
  { a: "driver_room", b: "garage_double", relation: "desired" },
  { a: "driver_room", b: "master_bedroom", relation: "undesired" },
  { a: "driver_room", b: "bedroom", relation: "undesired" },
  { a: "nanny_room", b: "master_bedroom", relation: "undesired" },
  { a: "nanny_room", b: "bedroom", relation: "undesired" },
  { a: "reception", b: "bedroom", relation: "undesired" },
  { a: "reception", b: "master_bedroom", relation: "undesired" },
];

/** Today's exact behavior for every caller that doesn't pass its own
 * `rules` list: the sourced base plus this household's cultural overlay,
 * combined. */
export const ROOM_RELATIONSHIPS: RelationRow[] = [...BASE_ROOM_RELATIONSHIPS, ...CULTURAL_ROOM_RELATIONSHIPS];

export interface AdjacencyStatus extends RelationRow {
  /** True when the relation holds -- not touching for `undesired`, a
   * direct door for `required`, at most `EASY_ACCESS_HOPS` doors away for
   * `desired`. Only set when both room types actually have at least one
   * instance somewhere in the plan; a row where either type is entirely
   * absent is left out of the result altogether, not reported as
   * failing. A house with no garage is never penalized for lacking a
   * garage. */
  ok: boolean;
  /** Instance ids that declared an owner via `attachedTo` and don't
   * actually have a real door to it -- see `checkAdjacency`'s own doc
   * comment. Empty whenever nothing declared one, which is most of the
   * time. */
  failedInstanceIds: string[];
  /** Whether the two types share a wall at all, independent of `ok` --
   * for `undesired` this is the same fact `ok` is built from, but for
   * `required`/`desired` it is not: a failing row can still have
   * `touching: true` (a wall with no door in it), which is a different,
   * more specific thing to tell someone than "these aren't even near
   * each other." A consumer building a message can use this to say
   * which one actually happened. */
  touching: boolean;
  /** A representative storey to point someone at -- the lowest floor
   * both types share, or (for a `desired` pair with no shared floor at
   * all, reached only across a stair) the lower of the two types' own
   * lowest floors. Not a claim that the *problem* lives on this exact
   * floor when a type has several instances spread across the house,
   * only a reasonable "start looking here." */
  level: number;
}

/** At most this many doors between them still counts as easy access for
 * a `desired` row -- a direct door (1) or one connecting room, a hallway
 * say (2). Sourced from the same adjacency-matrix literature `required`
 * and `undesired` draw on: "near but not touching... a corridor between
 * them is fine" is a hop count of 2, not a distance in meters. */
const EASY_ACCESS_HOPS = 2;

/** Every relationship-table row whose two room types both appear
 * somewhere in the plan. `undesired` is checked against
 * `circulation.ts`'s per-storey touch data -- the same carved, post-carve
 * outlines its door graph is itself built from, so this reads one
 * consistent notion of "touching," not a second slightly different one.
 * `required`/`desired` are checked against that door graph directly: a
 * shared wall with nothing cut into it does not satisfy them, only an
 * actual door does. Satisfied on any storey where an instance of each
 * type connects the right way (or, for undesired, does not touch at
 * all); a required/desired pair only needs one storey to satisfy it,
 * since a plan is one arrangement, not a per-storey score.
 *
 * A required row is checked at the *type* level by default -- "does at
 * least one instance of each type connect" -- which is right for a type
 * that normally has one instance (an Entry, a Kitchen) but is not enough
 * once a type can legitimately appear more than once with each instance
 * needing its own separate attachment: two ensuite bathrooms off one
 * primary suite ("his" and "hers"), say. "At least one connects" would
 * report success even if only one of the two actually does, silently
 * covering for the other. `Box.attachedTo` is how an instance declares
 * which one it is required to connect to; when it does, that specific
 * claim is checked on its own, against the same door graph, and failing
 * it fails the row, regardless of whether some other, untagged instance
 * happens to satisfy the type-level check. An instance that never
 * declares an owner is judged exactly as it always was -- this narrows
 * one real gap, it does not force every ensuite in the tool to be tagged
 * to get a correct answer. */
export function checkAdjacency(
  boxes: Box[],
  storeys: number,
  arrows: Arrow[],
  autoCarve: boolean,
  rules: RelationRow[] = ROOM_RELATIONSHIPS,
): AdjacencyStatus[] {
  const doorGraph = buildCirculationGraphMemo(boxes, storeys, arrows, autoCarve);
  const out: AdjacencyStatus[] = [];
  for (const row of rules) {
    // Present "anywhere," not "on the same storey": easy access can
    // legitimately cross a storey via a stair, so a desired pair on
    // different floors still deserves an answer, not a silent skip.
    // required/undesired never connect across floors in this tool's own
    // model (a door graph edge never crosses levels except through a
    // stair's own bridging), so this wider net costs them nothing.
    const anywhereA = boxes.filter((b) => !b.deleted && b.placed !== false && b.roomType === row.a);
    const anywhereB = boxes.filter((b) => !b.deleted && b.placed !== false && b.roomType === row.b);
    if (!anywhereA.length || !anywhereB.length) continue;

    let doorConnected = false;
    let touchingAtAll = false;
    let sharedLevel: number | null = null;
    const failedInstanceIds: string[] = [];
    for (let level = 0; level < storeys; level++) {
      const live = liveBoxes(boxes, level);
      const as_ = live.filter((b) => b.roomType === row.a);
      const bs_ = live.filter((b) => b.roomType === row.b);
      if (!as_.length || !bs_.length) continue;
      if (sharedLevel === null) sharedLevel = level;
      const { touchGraph } = levelTouchDataMemo(boxes, level, autoCarve);
      for (const a of as_) {
        if ((touchGraph.get(a.id) ?? []).some((e) => bs_.some((b) => b.id === e.to))) touchingAtAll = true;
      }
      if (row.relation === "undesired") continue;
      for (const a of as_) {
        const edges = doorGraph.get(a.id) ?? [];
        if (edges.some((e) => bs_.some((b) => b.id === e.to))) doorConnected = true;
        if (a.attachedTo && !edges.some((e) => e.to === a.attachedTo)) failedInstanceIds.push(a.id);
      }
      for (const b of bs_) {
        const edges = doorGraph.get(b.id) ?? [];
        if (edges.some((e) => as_.some((a) => a.id === e.to))) doorConnected = true;
        if (b.attachedTo && !edges.some((e) => e.to === b.attachedTo)) failedInstanceIds.push(b.id);
      }
    }
    // No storey shared at all -- only possible for `desired`, reached
    // only across a stair -- so fall back to the lower of the two
    // types' own lowest floors as the best available "start here."
    const level = sharedLevel ?? Math.min(...anywhereA.map((a) => a.level), ...anywhereB.map((b) => b.level));

    let satisfied: boolean;
    if (row.relation === "undesired") satisfied = touchingAtAll;
    else if (row.relation === "required") satisfied = doorConnected;
    else {
      const hops = minHopCount(
        doorGraph,
        anywhereA.map((a) => a.id),
        new Set(anywhereB.map((b) => b.id)),
      );
      satisfied = hops !== null && hops <= EASY_ACCESS_HOPS;
    }
    const ok = (row.relation === "undesired" ? !satisfied : satisfied) && failedInstanceIds.length === 0;
    out.push({ ...row, ok, failedInstanceIds, touching: touchingAtAll, level });
  }
  return out;
}

/** Public < Semi-public < Private. Exported so a consumer turning a
 * `TierViolation` into a sentence can say which side is the more public
 * one, without redefining the ordering a second time. */
export const TIER_ORDER: Record<PrivacyTier, number> = { public: 0, "semi-public": 1, private: 2 };

export interface TierViolation {
  roomAId: string;
  roomBId: string;
  tierA: PrivacyTier;
  tierB: PrivacyTier;
  /** The storey the door itself is on. */
  level: number;
}

function resolveTier(b: Box, tierOf: (roomType: string) => PrivacyTier | undefined): PrivacyTier | undefined {
  return b.privacyTierOverride ?? tierOf(b.roomType);
}

/** Every real door (an edge in `circulation.ts`'s own door graph, so a
 * shared wall with no door on it is not evaluated -- that is
 * `checkAdjacency`'s question, not this one) whose two sides sit more
 * than one tier apart: Public straight to Private, skipping Semi-public.
 * A room exempt from tier (rooms.ts's `tier: undefined` -- bathrooms,
 * Service rooms) never triggers this either side; the check simply skips
 * it, per "bathrooms don't have to follow these tiers." One unordered
 * result per door pair, not two. */
export function tierViolations(
  boxes: Box[],
  storeys: number,
  arrows: Arrow[],
  autoCarve: boolean,
  tierOf: (roomType: string) => PrivacyTier | undefined,
): TierViolation[] {
  const graph = buildCirculationGraphMemo(boxes, storeys, arrows, autoCarve);
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const seen = new Set<string>();
  const out: TierViolation[] = [];
  for (const [fromId, edges] of graph) {
    for (const edge of edges) {
      const pairKey = fromId < edge.to ? `${fromId}|${edge.to}` : `${edge.to}|${fromId}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      const a = byId.get(fromId);
      const b = byId.get(edge.to);
      if (!a || !b) continue;
      const tierA = resolveTier(a, tierOf);
      const tierB = resolveTier(b, tierOf);
      if (tierA === undefined || tierB === undefined) continue;
      if (Math.abs(TIER_ORDER[tierA] - TIER_ORDER[tierB]) > 1) {
        out.push({ roomAId: a.id, roomBId: b.id, tierA, tierB, level: edge.level });
      }
    }
  }
  return out;
}

export interface StairConnectionProblem {
  stairId: string;
  otherRoomId: string;
  otherRoomType: string;
  level: number;
}

/** Every door that connects a stair straight to something that isn't
 * itself a circulation space (rooms.ts's `circulation` -- Entry, Hallway,
 * Mudroom, another Stair). A stair has to serve every room on the floors
 * it reaches, not just one; landing inside a specific bedroom or kitchen
 * makes that room an involuntary through-route for everyone using the
 * stairs, and the tier check alone won't catch it -- Stair and Bedroom
 * are adjacent tiers (Semi-public, Private), which is normally exactly
 * fine (that's what a Hallway-Bedroom door is). This is a narrower,
 * dedicated rule about what a stair specifically may open onto, not a
 * gradient question. */
export function stairConnectionProblems(
  boxes: Box[],
  storeys: number,
  arrows: Arrow[],
  autoCarve: boolean,
  circulationOf: (roomType: string) => boolean,
): StairConnectionProblem[] {
  const graph = buildCirculationGraphMemo(boxes, storeys, arrows, autoCarve);
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const seen = new Set<string>();
  const out: StairConnectionProblem[] = [];
  for (const [fromId, edges] of graph) {
    const from = byId.get(fromId);
    if (!from || from.roomType !== "stair") continue;
    for (const edge of edges) {
      const to = byId.get(edge.to);
      if (!to || circulationOf(to.roomType)) continue;
      const key = `${fromId}|${edge.to}|${edge.level}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ stairId: from.id, otherRoomId: to.id, otherRoomType: to.roomType, level: edge.level });
    }
  }
  return out;
}

export type Severity = "problem" | "recommendation";

/** `required` and `undesired` are hard problems: a real requirement
 * unmet, or a real conflict present. `desired` is a softer, "usually a
 * good idea" recommendation. The one place this split is decided, so a
 * UI (StatusBar) and a scoring function (`scoreCandidate`) read the same
 * rule instead of two copies that could drift apart. */
export function adjacencySeverity(row: AdjacencyStatus): Severity {
  return row.relation === "desired" ? "recommendation" : "problem";
}

export interface Findings {
  reachability: ReachabilityProblem[];
  adjacency: AdjacencyStatus[];
  tier: TierViolation[];
  stairConnection: StairConnectionProblem[];
  gaps: GapFinding[];
  circulationRatio: CirculationRatioFinding[];
  overhangs: OverhangFinding[];
  corridorWaste: CorridorWasteFinding[];
  /** Life-safety, not cost -- see efficiency.ts's `deadEndHallways` for
   * why this one, alone among the efficiency.ts findings, counts as a
   * hard problem in `scoreCandidate` below. */
  deadEndHallways: DeadEndFinding[];
}

/** Whether two room types are meant to stay apart -- efficiency.ts's
 * `unnecessaryGaps` takes this as a parameter rather than reading
 * `ROOM_RELATIONSHIPS` itself, so that file never has to import this one
 * (which already imports it, for `collectFindings`). Order-independent:
 * a `rules` list is never expected to list the same pair both ways round.
 * Defaults to `ROOM_RELATIONSHIPS` -- today's behavior -- for every caller
 * that doesn't pass its own list. */
function isUndesiredPair(a: string, b: string, rules: RelationRow[] = ROOM_RELATIONSHIPS): boolean {
  return rules.some((r) => r.relation === "undesired" && ((r.a === a && r.b === b) || (r.a === b && r.b === a)));
}

/**
 * Every finding, for the plan as it stands right now -- the one call a
 * consumer (a store selector, a status-bar hook, whatever Task 5 ends up
 * building) needs to make. Recomputed fresh from the current arrangement
 * every time, like everything else this tool derives rather than stores:
 * there is no cached "findings" state anywhere to fall out of step.
 *
 * Deliberately not filtered, sorted or de-duplicated for display -- that
 * is a UI decision (which finding is worth surfacing first, whether an
 * adjacency success is even worth mentioning), not this function's. It
 * hands back exactly what each check itself returns.
 */
export function collectFindings(
  boxes: Box[],
  storeys: number,
  arrows: Arrow[],
  autoCarve: boolean,
  passableOf: (roomType: string) => boolean,
  tierOf: (roomType: string) => PrivacyTier | undefined,
  auxiliaryOf: (roomType: string) => boolean,
  circulationOf: (roomType: string) => boolean,
  rules: RelationRow[] = ROOM_RELATIONSHIPS,
): Findings {
  return {
    reachability: reachabilityProblems(boxes, storeys, arrows, autoCarve, passableOf, auxiliaryOf, tierOf),
    adjacency: checkAdjacency(boxes, storeys, arrows, autoCarve, rules),
    tier: tierViolations(boxes, storeys, arrows, autoCarve, tierOf),
    stairConnection: stairConnectionProblems(boxes, storeys, arrows, autoCarve, circulationOf),
    gaps: unnecessaryGaps(boxes, storeys, autoCarve, (a, b) => isUndesiredPair(a, b, rules)),
    circulationRatio: circulationRatio(boxes, storeys, autoCarve, circulationOf),
    overhangs: overhangs(boxes, storeys, autoCarve),
    corridorWaste: corridorWaste(boxes, storeys, arrows, autoCarve),
    deadEndHallways: deadEndHallways(boxes, storeys, arrows, autoCarve),
  };
}

export interface Score {
  /** A weighted total, not a raw count: every tier violation,
   * reachability problem, stair-connection problem and unmet
   * `required`/`undesired` adjacency row counts as 1 (they carry no
   * continuous magnitude of their own), but each dead-end hallway past
   * the code limit (efficiency.ts's `deadEndHallways`) is weighted by how
   * far past that limit it runs -- a corridor barely over the limit
   * counts for less than one stranding people 20 m from the nearest exit.
   * Anything nonzero here would show up in the status bar's Problems
   * line. A candidate with any of these is not acceptable, whatever else
   * it gets right. */
  hardProblems: number;
  /** A weighted total, not a raw count: every unmet `desired` adjacency
   * row counts as 1, but every unnecessary gap, over-ratio storey,
   * overhang and wasted corridor stub (efficiency.ts) is weighted by its
   * own magnitude -- a gap a hair short of touching counts for much more
   * than one a hair short of the threshold that stops it being a gap at
   * all, and likewise for the others. The status bar's Recommendations
   * line. Never blocks a candidate from passing; only ranks it against
   * other candidates that are equally free of hard problems. */
  softRecommendations: number;
  /** The findings the two counts above were taken from, so a caller can
   * explain *why* a candidate scored the way it did, not just report the
   * number. */
  findings: Findings;
}

function sumWeights<T>(items: T[], weight: (item: T) => number): number {
  return items.reduce((total, item) => total + weight(item), 0);
}

/** How much of `GAP_THRESHOLD_M`'s own range a gap has eaten into -- 1 at
 * the tightest reportable gap (just past floating-point touching, per
 * `TOUCHING_TOL_M`), approaching 0 at the threshold itself. The closer to
 * touching, the more it actually costs to leave unclosed. */
function gapWeight(gapM: number): number {
  return Math.max(0, (GAP_THRESHOLD_M - gapM) / (GAP_THRESHOLD_M - TOUCHING_TOL_M));
}

/** How far a storey's circulation ratio runs past the point
 * `circulationRatio` starts flagging it at all -- `efficiency.ts` only
 * ever reports a finding above `CIRCULATION_RATIO_THRESHOLD`, so this is
 * always a positive overshoot, larger for a storey that spends far more
 * of itself on hallways than one that just tips over the line. */
function circulationRatioWeight(f: CirculationRatioFinding): number {
  return Math.max(0, f.ratio - CIRCULATION_RATIO_THRESHOLD);
}

/** How far an exposed wall runs past `OVERHANG_THRESHOLD_M` -- same
 * "overshoot past the point this is even reported" shape as the other
 * efficiency weights, in meters. */
function overhangWeight(f: OverhangFinding): number {
  return Math.max(0, f.exposedM - OVERHANG_THRESHOLD_M);
}

/** How far a corridor's wasted stub runs past `CORRIDOR_STUB_THRESHOLD_M`. */
function corridorWasteWeight(f: CorridorWasteFinding): number {
  return Math.max(0, f.wastedM - CORRIDOR_STUB_THRESHOLD_M);
}

/** How far a dead-end branch runs past the real code limit
 * (`DEAD_END_LIMIT_M`) that makes it a hard problem at all -- a corridor
 * barely over the limit is a smaller defect than one stranding people
 * far past it, even though both are equally real violations. */
function deadEndWeight(f: DeadEndFinding): number {
  return Math.max(0, f.distanceM - DEAD_END_LIMIT_M);
}

/**
 * The intended entry point for anything that needs to judge a candidate
 * room arrangement -- a future generator (Task 8/9), or anything else
 * that wants a pass/fail and a ranking rather than a raw finding list.
 * Built directly on `collectFindings`; adds no checking logic of its
 * own, only two counts.
 *
 * Deliberately two numbers, not one blended score: collapsing hard
 * problems and soft recommendations into a single weighted number would
 * let enough satisfied recommendations outweigh an unmet requirement,
 * which is exactly backwards. Use `compareScores` to rank two scores
 * correctly -- hard problems always decide first.
 */
export function scoreCandidate(
  boxes: Box[],
  storeys: number,
  arrows: Arrow[],
  autoCarve: boolean,
  passableOf: (roomType: string) => boolean,
  tierOf: (roomType: string) => PrivacyTier | undefined,
  auxiliaryOf: (roomType: string) => boolean,
  circulationOf: (roomType: string) => boolean,
  rules: RelationRow[] = ROOM_RELATIONSHIPS,
): Score {
  const findings = collectFindings(boxes, storeys, arrows, autoCarve, passableOf, tierOf, auxiliaryOf, circulationOf, rules);
  const unmetAdjacency = findings.adjacency.filter((r) => !r.ok);
  // Tier violations, reachability problems, stair-connection problems and
  // unmet required/undesired adjacency rows carry no continuous magnitude
  // of their own (see each type's own fields) -- they stay a flat count of
  // 1 each. Dead-end hallways do carry one (how far past the real code
  // limit), so that's weighted instead of merely counted.
  const hardProblems =
    findings.tier.length +
    findings.reachability.length +
    findings.stairConnection.length +
    sumWeights(findings.deadEndHallways, deadEndWeight) +
    unmetAdjacency.filter((r) => adjacencySeverity(r) === "problem").length;
  const softRecommendations =
    unmetAdjacency.filter((r) => adjacencySeverity(r) === "recommendation").length +
    sumWeights(findings.gaps, (g) => gapWeight(g.gapM)) +
    sumWeights(findings.circulationRatio, circulationRatioWeight) +
    sumWeights(findings.overhangs, overhangWeight) +
    sumWeights(findings.corridorWaste, corridorWasteWeight);
  return { hardProblems, softRecommendations, findings };
}

/** Whether `a` outranks `b`: negative when `a` is better, positive when
 * `b` is better, 0 when they're equal on both counts -- the standard
 * shape `Array.prototype.sort` expects, so ranking a list of candidates
 * is `candidates.sort(compareScores)`. Hard problems decide first; soft
 * recommendations only break a tie between two candidates that are
 * already equally free of hard problems. */
export function compareScores(a: Score, b: Score): number {
  return a.hardProblems - b.hardProblems || a.softRecommendations - b.softRecommendations;
}

/**
 * Two checks over the same idea -- a room-type adjacency table, sourced
 * where it could be (see each row's comment) and marked provisional where
 * it could not, per Task 2 -- but kept as two independent functions, not
 * merged, because they answer different questions and neither implies
 * the other:
 *
 * `checkAdjacency` asks whether the *right* rooms ended up near each
 * other. For `undesired`, that's physical adjacency alone (a shared
 * wall, via `circulation.ts`'s own touch graph) -- a garage's noise and
 * heat cross a wall whether or not a door was ever cut into it, so a
 * touching pair is the problem regardless. For `required`/`desired`,
 * it's the opposite: a shared wall with no door on it satisfies nothing
 * -- the entire reason kitchen-dining adjacency is required is so people
 * can walk quickly between them, and a wall with no door achieves that
 * no better than not being adjacent at all. So required/desired checks
 * `circulation.ts`'s own door graph (the same one `reachabilityProblems`
 * and `tierViolations` already use), not the touch graph -- two rooms can
 * share a wall and still fail a required row if nobody ever put a door in
 * it. Checked at the type level by default ("does at least one instance
 * of each type connect"), with an opt-in, per-instance escape hatch
 * (`Box.attachedTo`) for the case type-level checking cannot see on its
 * own -- two required instances of the same type (two ensuite bathrooms
 * off one primary suite) where one being satisfied could otherwise
 * silently cover for the other failing. A declared `attachedTo` is
 * checked against the same door graph too: a bathroom touching its
 * claimed bedroom with no actual door between them is exactly as broken
 * as one that doesn't touch it at all.
 *
 * `tierViolations` asks whether a *door* respects the public-to-private
 * gradient (rooms.ts's `tier`): a door may connect adjacent tiers but
 * never skip one. This is about actual doors, not mere adjacency -- two
 * zones can share a wall with no door at all, which is `circulation.ts`'s
 * question, not this one.
 *
 * `collectFindings`, at the bottom, ties this file's two checks and
 * `circulation.ts`'s third (`reachabilityProblems`) into the one call a
 * consumer needs -- but it hands back raw, structured results only
 * (room ids, tiers, relation kinds), no wording and no UI. Turning that
 * into something a person reads (icons, plain-language sentences, a
 * panel) is deliberately a separate step: this file's job stops at
 * making the findings computable, not at deciding how they look.
 *
 * Both checks are read-only diagnostics. Neither ever moves, resizes or
 * auto-connects anything -- same "flag, never force" rule as the rest of
 * this tool.
 */
import { buildCirculationGraph, levelTouchData, reachabilityProblems, type ReachabilityProblem } from "./circulation";
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
 */
export const ROOM_RELATIONSHIPS: RelationRow[] = [
  // -- Sourced (Carolyn Matthews, "Adjacency Matrix Decoded") --
  { a: "kitchen", b: "dining_room", relation: "required" },
  { a: "kitchen", b: "laundry", relation: "desired" },
  { a: "mudroom", b: "laundry", relation: "desired" },
  { a: "bedroom", b: "bathroom", relation: "desired" },
  { a: "bedroom", b: "garage_single", relation: "undesired" },
  { a: "bedroom", b: "garage_double", relation: "undesired" },
  { a: "master_bedroom", b: "garage_single", relation: "undesired" },
  { a: "master_bedroom", b: "garage_double", relation: "undesired" },
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
  { a: "master_bedroom", b: "bathroom", relation: "required" },
  { a: "entry", b: "hallway", relation: "required" },
  { a: "garage_single", b: "mudroom", relation: "desired" },
  { a: "garage_double", b: "mudroom", relation: "desired" },
  { a: "garage_single", b: "entry", relation: "desired" },
  { a: "garage_double", b: "entry", relation: "desired" },
  { a: "bedroom", b: "kitchen", relation: "undesired" },
  { a: "master_bedroom", b: "kitchen", relation: "undesired" },
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
  // -- Sourced (generic principle: a quiet office kept from noisy/service space) --
  { a: "office", b: "kitchen", relation: "undesired" },
  { a: "office", b: "laundry", relation: "undesired" },
  { a: "office", b: "garage_single", relation: "undesired" },
  { a: "office", b: "garage_double", relation: "undesired" },
];

export interface AdjacencyStatus extends RelationRow {
  /** True when the relation holds -- touching for required/desired, not
   * touching for undesired. Only set when both room types actually have
   * at least one instance somewhere in the plan; a row where either type
   * is entirely absent is left out of the result altogether, not
   * reported as failing. A house with no garage is never penalized for
   * lacking a garage. */
  ok: boolean;
  /** Instance ids that declared an owner via `attachedTo` and don't
   * actually touch it -- see `checkAdjacency`'s own doc comment. Empty
   * whenever nothing declared one, which is most of the time. */
  failedInstanceIds: string[];
  /** Whether the two types share a wall at all, independent of `ok` --
   * for `undesired` this is the same fact `ok` is built from, but for
   * `required`/`desired` it is not: a failing row can still have
   * `touching: true` (a wall with no door in it), which is a different,
   * more specific thing to tell someone than "these aren't even near
   * each other." A consumer building a message can use this to say
   * which one actually happened. */
  touching: boolean;
}

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
export function checkAdjacency(boxes: Box[], storeys: number, arrows: Arrow[], autoCarve: boolean): AdjacencyStatus[] {
  const doorGraph = buildCirculationGraph(boxes, storeys, arrows, autoCarve);
  const out: AdjacencyStatus[] = [];
  for (const row of ROOM_RELATIONSHIPS) {
    let present = false;
    let satisfied = false;
    let touchingAtAll = false;
    const failedInstanceIds: string[] = [];
    for (let level = 0; level < storeys; level++) {
      const live = liveBoxes(boxes, level);
      const as_ = live.filter((b) => b.roomType === row.a);
      const bs_ = live.filter((b) => b.roomType === row.b);
      if (!as_.length || !bs_.length) continue;
      present = true;
      const { touchGraph } = levelTouchData(boxes, level, autoCarve);
      for (const a of as_) {
        if ((touchGraph.get(a.id) ?? []).some((e) => bs_.some((b) => b.id === e.to))) touchingAtAll = true;
      }
      if (row.relation === "undesired") continue;
      for (const a of as_) {
        const edges = doorGraph.get(a.id) ?? [];
        if (edges.some((e) => bs_.some((b) => b.id === e.to))) satisfied = true;
        if (a.attachedTo && !edges.some((e) => e.to === a.attachedTo)) failedInstanceIds.push(a.id);
      }
      for (const b of bs_) {
        const edges = doorGraph.get(b.id) ?? [];
        if (edges.some((e) => as_.some((a) => a.id === e.to))) satisfied = true;
        if (b.attachedTo && !edges.some((e) => e.to === b.attachedTo)) failedInstanceIds.push(b.id);
      }
    }
    if (!present) continue;
    if (row.relation === "undesired") satisfied = touchingAtAll;
    const ok = (row.relation === "undesired" ? !satisfied : satisfied) && failedInstanceIds.length === 0;
    out.push({ ...row, ok, failedInstanceIds, touching: touchingAtAll });
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
  const graph = buildCirculationGraph(boxes, storeys, arrows, autoCarve);
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
        out.push({ roomAId: a.id, roomBId: b.id, tierA, tierB });
      }
    }
  }
  return out;
}

export interface Findings {
  reachability: ReachabilityProblem[];
  adjacency: AdjacencyStatus[];
  tier: TierViolation[];
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
  isServiceOf: (roomType: string) => boolean,
): Findings {
  return {
    reachability: reachabilityProblems(boxes, storeys, arrows, autoCarve, passableOf, auxiliaryOf, isServiceOf),
    adjacency: checkAdjacency(boxes, storeys, arrows, autoCarve),
    tier: tierViolations(boxes, storeys, arrows, autoCarve, tierOf),
  };
}

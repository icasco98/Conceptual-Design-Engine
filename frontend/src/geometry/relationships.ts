/**
 * Two checks over the same idea -- a room-type adjacency table, sourced
 * where it could be (see each row's comment) and marked provisional where
 * it could not, per Task 2 -- but kept as two independent functions, not
 * merged, because they answer different questions and neither implies
 * the other:
 *
 * `checkAdjacency` asks whether the *right* rooms ended up near each
 * other: physical adjacency (a shared wall, via the same touch graph
 * `circulation.ts` builds its door graph from), independent of whether a
 * door was ever placed on it.
 *
 * `tierViolations` asks whether a *door* respects the public-to-private
 * gradient (rooms.ts's `tier`): a door may connect adjacent tiers but
 * never skip one. This is about actual doors, not mere adjacency -- two
 * zones can share a wall with no door at all, which is `circulation.ts`'s
 * question, not this one.
 *
 * Both are read-only diagnostics. Neither ever moves, resizes or
 * auto-connects anything -- same "flag, never force" rule as the rest of
 * this tool.
 */
import { buildCirculationGraph, levelTouchData } from "./circulation";
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
}

/** Every relationship-table row whose two room types both appear
 * somewhere in the plan, checked against whatever's actually touching --
 * reusing `circulation.ts`'s own per-storey touch data so this reads the
 * same carved, post-carve outlines the door graph does, rather than a
 * second, slightly different notion of "touching." Satisfied on any
 * storey where an instance of each type shares a wall (required/desired)
 * or does not (undesired); a required/desired pair only needs one storey
 * to satisfy it, since a plan is one arrangement, not a per-storey score. */
export function checkAdjacency(boxes: Box[], storeys: number, autoCarve: boolean): AdjacencyStatus[] {
  const out: AdjacencyStatus[] = [];
  for (const row of ROOM_RELATIONSHIPS) {
    let present = false;
    let touches = false;
    for (let level = 0; level < storeys && !touches; level++) {
      const live = liveBoxes(boxes, level);
      const as_ = live.filter((b) => b.roomType === row.a);
      const bs_ = live.filter((b) => b.roomType === row.b);
      if (!as_.length || !bs_.length) continue;
      present = true;
      const { touchGraph } = levelTouchData(boxes, level, autoCarve);
      for (const a of as_) {
        if ((touchGraph.get(a.id) ?? []).some((e) => bs_.some((b) => b.id === e.to))) {
          touches = true;
          break;
        }
      }
    }
    if (!present) continue;
    out.push({ ...row, ok: row.relation === "undesired" ? !touches : touches });
  }
  return out;
}

const TIER_ORDER: Record<PrivacyTier, number> = { public: 0, "semi-public": 1, private: 2 };

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

/**
 * The sample house the editor opens on.
 *
 * Every room is placed by hand, in plan-frame meters, and nothing
 * generates it: the point of this fork is a tool driven by the person
 * drawing, so its starting layout is one a person drew. It is here so
 * that trying the editor never means building a plan from nothing first.
 *
 * Rebuilt from scratch around this tool's own room-relationship rules
 * (geometry/relationships.ts, geometry/circulation.ts) rather than
 * adapted from an earlier layout: every required door, every privacy-tier
 * step, every stair landing and almost every "easy access" pairing here
 * is deliberately engineered to score cleanly against `scoreCandidate` --
 * see the door-by-door reasoning below. The two rooms it does NOT force
 * (a nanny's quick access to the kitchen and to the laundry, both
 * upstairs-to-downstairs) are left as the honest, minor recommendations
 * they are, rather than contorted into a false zero.
 *
 * The plan is one long spine on each storey -- Hallway on the ground
 * floor, Landing above it, both the same rectangle so the stair's fixed
 * footprint (one box, shared across both levels) lands against each of
 * them the same way -- with every room its own spoke off that spine. A
 * spoke touches nothing but the spine unless the two are meant to be
 * door-connected: a small gap (never a door's own doing, since no door
 * can be cut into a gap) keeps every other pair of neighbours from
 * touching by accident, the same way a two-tier privacy skip or an
 * unwanted stair landing would be a real, checked mistake here, not a
 * cosmetic one. Every interior door is hand-placed for exactly this
 * reason: `suggestArrows`'s own entry-rooted walk doors only one wall per
 * newly-found room (a spanning tree, not every touching wall), which is
 * the right choice for letting a person's own drawing decide its own
 * doors, but the wrong one for a spoke that legitimately needs two doors
 * (a Kitchen needs both its Hallway door and its Dining Room door) --
 * this house's doors are load-bearing for the checks below, not a
 * demonstration of that walk.
 *
 * Kitchen and Dining Room keep a direct required door (Sourced,
 * relationships.ts); Master Bedroom and its Ensuite, Driver Room and its
 * own Bathroom, Nanny Room and its own Bathroom, and Entry and Reception
 * each keep one too. Every other "desired" pairing (kitchen-laundry,
 * mudroom-laundry, garage-mudroom, garage-entry, driver-garage,
 * driver-diwaniya, bedroom-bathroom, nanny-bedroom) is satisfied by
 * giving both rooms their own direct spine door: two spokes off the same
 * hub are always exactly two doors apart, whatever the plan's actual
 * shape, which is what "easy access" (EASY_ACCESS_HOPS = 2) asks for.
 * Diwaniya sits on the spine's *other* side from Entry -- its own
 * street-facing door for guests, and a second, ordinary door onto the
 * Hallway for the household (the internal door a diwaniya really has) --
 * so it is never physically adjacent to Entry (undesired) while still
 * being two doors from Driver Room (desired) through that shared
 * Hallway. Upstairs, Nanny Room's own spine door keeps it two doors from
 * every bedroom (desired) while a full bay of Bathroom sits physically
 * between it and Bedroom 2, so the two never actually touch (undesired).
 *
 * Two storeys, one stair spanning both, its own two doors landing on
 * Hallway and Landing and nothing else (a stair may only open onto
 * circulation space). Three exterior doors -- the front door on Entry,
 * the diwaniya's own street door, and the garage's own -- so the
 * household, a diwaniya guest and a car each have a door that is
 * actually theirs.
 *
 * "Reset to the sample layout" brings all of this back.
 */
import { newArrowId } from "./geometry/arrows";
import type { Arrow, Box, BoxKind, Plot, Rect } from "./geometry/types";
import { roomTypeInfo } from "./rooms";

/** Priority when nothing else is said: see `Box.priority`. Circulation
 *  is given the higher rank, because a corridor that gives way stops
 *  being a corridor. */
export const DEFAULT_PRIORITY = 2;
const CIRCULATION_PRIORITY = 1;

/** How many storeys the sample has. Rooms are assigned a level; the count
 *  is what the level tabs and the 3D view are built from. */
export const SAMPLE_STOREYS = 2;
/** Floor-to-floor height, meters. */
export const STOREY_HEIGHT_M = 3.0;

/** How many storeys a zone of this height occupies: one up to the storey
 *  height, and one more for every storey it reaches into after that. A
 *  hair of tolerance so a 3.0 m room in a 3.0 m storey is one storey. */
export function storeysSpanned(heightM: number): number {
  return Math.max(1, Math.ceil(heightM / STOREY_HEIGHT_M - 1e-6));
}

/** The drawing sheet. Purely a reference area — a faint rectangle on the
 *  plan and the ground plane under the 3D — and nothing stops a room being
 *  drawn outside it. To constrain a layout, switch the plot on instead. */
export const SHEET = { width: 35, depth: 20 };

/** The plot a project starts with: the sheet's own rectangle, switched
 *  off. Off is the only honest default — the tool cannot know the site
 *  until someone types it in, and a boundary invented for them would
 *  fence a layout in for no reason. */
export const DEFAULT_PLOT: Plot = { on: false, left: 0, top: 0, width: SHEET.width, depth: SHEET.depth };

/** Where the sample house's own origin sits on the sheet. */
const OX = 1;
const OY = 3;

/** Kept clear between any two spokes that are not meant to share a wall
 *  -- see the file doc comment: a gap, not a doorless wall, is what
 *  actually keeps them apart, since a carve or a future edit could still
 *  find a doorless-but-touching wall and put a door in it. */
const GAP = 0.3;

interface Placed {
  name: string;
  roomType: string;
  level: number;
  /** Vertical height when not the storey height; the stair is two tall. */
  heightM?: number;
  rect: [number, number, number, number];
  kind?: BoxKind;
  isEntry?: boolean;
}

// Each rect is [left, top, width, height] in meters relative to the house
// origin. Two spines -- Hallway (level 0) and Landing (level 1) -- share
// the same [left, top, width] so the Stair's one fixed footprint (a
// single box, spanning both levels) touches each of them identically.
// Every other room is a spoke off one spine or the other; see the file
// doc comment for which walls are meant to touch and which are kept
// apart by a deliberate GAP.
const SPINE: [number, number, number] = [0, 6.0, 32.4];
const SPINE_H = 1.4;
// Ground floor, west to east along the spine's south face.
const GARAGE_X = 0;
const DRIVER_ROOM_X = GARAGE_X + 3.6 + GAP;
const MUDROOM_X = DRIVER_ROOM_X + 3.3 + GAP;
const LAUNDRY_X = MUDROOM_X + 1.8 + GAP;
const KITCHEN_X = LAUNDRY_X + 1.8 + GAP;
const DINING_X = KITCHEN_X + 3.6; // no gap: required door, shared wall
const LIVING_X = DINING_X + 3.6 + GAP;
const STAIR_X = LIVING_X + 4.5 + GAP;
const ENTRY_X = STAIR_X + 1.2 + GAP;
const RECEPTION_X = ENTRY_X + 2.4; // no gap: required door, shared wall
// First floor, west to east along the spine's south face -- independent
// x positions from the ground floor's (only the Stair's fixed footprint,
// below, has to agree between the two).
const MASTER_X = 0;
const BEDROOM1_X = MASTER_X + 4.0 + GAP;
const BEDROOM2_X = BEDROOM1_X + 3.3 + GAP;
const BATH_SHARED_X = BEDROOM2_X + 3.3 + GAP;
const NANNY_X = BATH_SHARED_X + 1.8 + GAP;
const OFFICE_X = NANNY_X + 3.3 + GAP;

const PLACED: Placed[] = [
  // ---- the two spines ---------------------------------------------------
  { name: "Hallway", roomType: "hallway", level: 0, kind: "corridor", rect: [...SPINE, SPINE_H] },
  { name: "Landing", roomType: "hallway", level: 1, kind: "corridor", rect: [...SPINE, SPINE_H] },

  // ---- ground floor, north of the spine ----------------------------------
  // Its own street door for guests (sampleArrows, below) plus an
  // ordinary door onto the Hallway for the household -- the internal
  // door a real diwaniya has -- but never physically next to Entry
  // (relationships.ts: diwaniya-entry undesired), which sits at the
  // spine's opposite end, far along the south face.
  { name: "Diwaniya", roomType: "diwaniya", level: 0, rect: [0, -2.0, 6.5, 8.0] },

  // ---- ground floor, south of the spine, west to east --------------------
  { name: "Garage", roomType: "garage_single", level: 0, rect: [GARAGE_X, 7.4, 3.6, 6.5] },
  { name: "Driver Room", roomType: "driver_room", level: 0, rect: [DRIVER_ROOM_X, 7.4, 3.3, 3.6] },
  // Full width of Driver Room's own south wall, not a narrower slice of
  // it -- so its required door's t=0.5 lands inside the shared wall
  // regardless of which way `t` runs on that side.
  { name: "Driver Bathroom", roomType: "driver_bathroom", level: 0, rect: [DRIVER_ROOM_X, 11.0, 3.3, 2.4] },
  { name: "Mudroom", roomType: "mudroom", level: 0, rect: [MUDROOM_X, 7.4, 1.8, 2.1] },
  { name: "Laundry", roomType: "laundry", level: 0, rect: [LAUNDRY_X, 7.4, 1.8, 2.4] },
  { name: "Kitchen", roomType: "kitchen", level: 0, rect: [KITCHEN_X, 7.4, 3.6, 4.2] },
  // Same height as Kitchen, so their shared wall runs its full length --
  // required, relationships.ts.
  { name: "Dining Room", roomType: "dining_room", level: 0, rect: [DINING_X, 7.4, 3.6, 4.2] },
  { name: "Living Room", roomType: "living_room", level: 0, rect: [LIVING_X, 7.4, 4.5, 5.5] },
  { name: "Stair", roomType: "stair", level: 0, heightM: 2 * STOREY_HEIGHT_M, rect: [STAIR_X, 7.4, 1.2, 3.0] },
  { name: "Entry", roomType: "entry", level: 0, rect: [ENTRY_X, 7.4, 2.4, 2.4], isEntry: true },
  // Entry's own height (2.4) is the shorter of the two, so it is also
  // the shared wall's full extent -- required, relationships.ts.
  { name: "Reception", roomType: "reception", level: 0, rect: [RECEPTION_X, 7.4, 4.5, 5.5] },

  // ---- first floor, south of the spine, west to east ---------------------
  { name: "Master Bedroom", roomType: "master_bedroom", level: 1, rect: [MASTER_X, 7.4, 4.0, 4.5] },
  // Full width of Master Bedroom's own south wall -- required,
  // relationships.ts, same reasoning as Driver Bathroom above.
  { name: "Ensuite", roomType: "bathroom", level: 1, rect: [MASTER_X, 11.9, 4.0, 2.4] },
  { name: "Bedroom 1", roomType: "bedroom", level: 1, rect: [BEDROOM1_X, 7.4, 3.3, 3.6] },
  { name: "Bedroom 2", roomType: "bedroom", level: 1, rect: [BEDROOM2_X, 7.4, 3.3, 3.6] },
  // Its own Landing door keeps it two doors from every bedroom (desired)
  // without ever needing to touch one directly. Physically, it is also
  // what keeps Bedroom 2 and Nanny Room apart -- see below.
  { name: "Bathroom", roomType: "bathroom", level: 1, rect: [BATH_SHARED_X, 7.4, 1.8, 2.4] },
  // Bathroom, immediately west, is the whole reason Nanny Room's west
  // wall never touches Bedroom 2's east wall: nanny_room-bedroom is
  // *both* desired (easy access -- satisfied via the Landing, two doors
  // either way) *and* undesired (no shared wall) in relationships.ts,
  // the deliberate "close by, never adjoining" reading of where a
  // nanny's own room sits relative to the children's.
  { name: "Nanny Room", roomType: "nanny_room", level: 1, rect: [NANNY_X, 7.4, 3.3, 3.6] },
  { name: "Nanny Bathroom", roomType: "nanny_bathroom", level: 1, rect: [NANNY_X, 11.0, 3.3, 2.4] },
  { name: "Office", roomType: "office", level: 1, rect: [OFFICE_X, 7.4, 3.0, 3.3] },
];

export function sampleBoxes(): Box[] {
  return PLACED.map((p) => {
    const info = roomTypeInfo(p.roomType);
    const rect: Rect = { left: OX + p.rect[0], top: OY + p.rect[1], width: p.rect[2], height: p.rect[3] };
    const kind: BoxKind = p.kind ?? "room";
    return {
      id: `${kind}:${p.level}:${p.name}`,
      name: p.name,
      kind,
      shape: "rect",
      roomType: p.roomType,
      isEntry: p.isEntry ?? false,
      level: p.level,
      levelTo: p.level + storeysSpanned(p.heightM ?? STOREY_HEIGHT_M) - 1,
      heightM: p.heightM ?? STOREY_HEIGHT_M,
      ...rect,
      // A corridor's minimum is its clear width both ways: it can be any
      // length, but never narrower than a hallway.
      minWidth: kind === "corridor" ? 1.2 : info.minWidth,
      minHeight: kind === "corridor" ? 1.2 : info.minHeight,
      rotation: 0,
      priority: kind === "corridor" || p.roomType === "stair" ? CIRCULATION_PRIORITY : DEFAULT_PRIORITY,
      carvedBy: [],
      deleted: false,
      placed: true,
      initial: rect,
    };
  });
}

/** The sample's own placed doors -- every one of them, interior and
 *  exterior alike, hand-placed rather than left to `suggestArrows` (see
 *  the file doc comment for why). `side`: 0 top, 1 right, 2 bottom, 3
 *  left (arrows.ts's own `wallPointLocal`); `t` is a fraction of the
 *  *host's* own wall, so hosting from whichever room's wall is the
 *  shorter (or an exactly matching) side of a shared wall keeps `t: 0.5`
 *  inside the real touching segment regardless of which way it runs. */
export function sampleArrows(boxes: Box[]): Arrow[] {
  const byName = (name: string) => boxes.find((b) => b.name === name)!;
  // `level` defaults to the host's own base level, which is right for
  // everything except the Stair: one box, spanning both storeys, needs a
  // door on each -- its second door's `level` has to be given explicitly
  // rather than read off the box, which only ever reports its base (0).
  const door = (name: string, side: number, opts?: { kind?: Arrow["kind"]; level?: number }): Arrow => {
    const host = byName(name);
    return { id: newArrowId(), level: opts?.level ?? host.level, hostId: host.id, side, t: 0.5, dir: 1, kind: opts?.kind ?? "interior" };
  };
  return [
    // ---- exterior doors: the household, a diwaniya guest, a car -------
    door("Entry", 2, { kind: "exterior-main" }),
    door("Diwaniya", 0, { kind: "exterior-side" }),
    door("Garage", 2, { kind: "exterior-side" }),

    // ---- ground floor spine doors --------------------------------------
    door("Diwaniya", 2), // the diwaniya's own internal, household door
    door("Garage", 0),
    door("Driver Room", 0),
    door("Mudroom", 0),
    door("Laundry", 0),
    door("Kitchen", 0),
    door("Dining Room", 0),
    door("Living Room", 0),
    door("Stair", 0),
    door("Entry", 0),

    // ---- ground floor direct doors --------------------------------------
    door("Entry", 1), // Entry <-> Reception
    door("Kitchen", 1), // Kitchen <-> Dining Room
    door("Driver Room", 2), // Driver Room <-> Driver Bathroom

    // ---- first floor spine doors ----------------------------------------
    door("Master Bedroom", 0),
    door("Bedroom 1", 0),
    door("Bedroom 2", 0),
    door("Bathroom", 0),
    door("Nanny Room", 0),
    door("Office", 0),
    door("Stair", 0, { level: 1 }), // the same Stair box, its upper door

    // ---- first floor direct doors ----------------------------------------
    door("Master Bedroom", 2), // Master Bedroom <-> Ensuite
    door("Nanny Room", 2), // Nanny Room <-> Nanny Bathroom
  ];
}

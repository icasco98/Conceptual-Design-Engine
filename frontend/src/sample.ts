/**
 * The sample house the editor opens on.
 *
 * Every room is placed by hand, in plan-frame meters, and nothing
 * generates it: the point of this fork is a tool driven by the person
 * drawing, so its starting layout is one a person drew. It is here so
 * that trying the editor never means building a plan from nothing first.
 *
 * Rebuilt a second time around two more rules (geometry/efficiency.ts)
 * the first rebuild's own single, house-spanning Hallway broke: real
 * construction charges for exterior wall and for floor area spent on
 * moving between rooms rather than living in them, and a hub-and-spoke
 * plan that gives every room its own corridor door is the cheapest way
 * to satisfy "easy access" (checkAdjacency's `desired`, at most two
 * doors) while ignoring both. This house does the opposite on purpose:
 *
 * - Every room that can reasonably abut its neighbour does, a real
 *   shared wall, not a gap held open in case a door needs cutting later.
 *   Two rooms are left apart only where relationships.ts actually calls
 *   for it (`undesired`) -- and even then, by putting a different,
 *   compatible room between them (Bathroom between Bedroom 2 and Nanny
 *   Room, below), not by leaving a void in the building.
 * - The household's living rooms chain into each other -- Living Room to
 *   Dining Room to Kitchen to Laundry to Mudroom to Garage/Driver Room --
 *   the way a real open plan does, rather than each hanging its own
 *   spoke off a corridor. Only Entry, Diwaniya, Living Room and Stair
 *   touch the ground floor's own Hallway, and only because the privacy
 *   gradient (tierViolations) genuinely requires a Semi-public step
 *   between Entry/Diwaniya (Public) and everything behind them
 *   (Private): that is what the Hallway is *for*, not a place to dock
 *   every room in the house. It stays a single small room, 2.4 x 2.4.
 * - Upstairs, bedrooms genuinely do want their own private door off one
 *   shared corridor -- nobody wants to walk through someone else's room
 *   to reach their own -- so Landing keeps that shape, but narrow (1.2 m,
 *   the tool's own corridor minimum) rather than room-width, and no
 *   longer than the row of doors it actually carries.
 *
 * The honest cost of building this way rather than gaming the hop count:
 * two `desired` rows this house cannot cheaply reach in two doors any
 * more (Driver Room to the Diwaniya it once reached only by having its
 * own corridor spur; Garage to Entry, the same way) join the two it
 * already couldn't (a nanny's own quick access to the kitchen and to the
 * laundry, both a floor away). All four are left as the honest, minor
 * recommendations they are. `scoreCandidate` still reports zero hard
 * problems -- these were never requirements, only nice-to-haves, and a
 * real plan is allowed to not have every nice-to-have.
 *
 * Two storeys, one stair spanning both, its own two doors landing on
 * Hallway and Landing and nothing else. Three exterior doors -- the
 * front door on Entry, the diwaniya's own street door, and the garage's
 * own -- so the household, a diwaniya guest and a car each have a door
 * that is actually theirs.
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
export const SHEET = { width: 40, depth: 22 };

/** The plot a project starts with: the sheet's own rectangle, switched
 *  off. Off is the only honest default — the tool cannot know the site
 *  until someone types it in, and a boundary invented for them would
 *  fence a layout in for no reason. */
export const DEFAULT_PLOT: Plot = { on: false, left: 0, top: 0, width: SHEET.width, depth: SHEET.depth };

/** Where the sample house's own origin sits on the sheet -- chosen so
 *  every room, on both storeys, lands at a positive coordinate; the two
 *  storeys are laid out independently (only the Stair's one shared
 *  footprint has to agree between them) and do not happen to share a
 *  footprint outline. */
const OX = 15;
const OY = 3;

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
// origin. Every touching pair below shares a real wall (no gap) unless
// relationships.ts's ROOM_RELATIONSHIPS actually lists that pair
// `undesired` -- see the file doc comment.
const PLACED: Placed[] = [
  // ---- ground floor: the small hub the privacy gradient requires -------
  // Public (Entry) may only ever step down to Semi-public, never straight
  // to Private -- Hallway is that one step, and stays exactly large
  // enough to be one: 2.4 x 2.4, three spokes, nothing routed through it
  // that doesn't need the step. The diwaniya's own household door goes
  // straight to Dining Room instead (below) -- also Semi-public, and a
  // real Gulf diwaniya's dining room often is dual-use this way -- rather
  // than fighting Hallway's own small footprint for a fourth spoke.
  // Wider than its own minimum on purpose: Entry's row sits on the east
  // part of this same south wall (below), clear of Living Room's own
  // wall to the west -- Living Room has to reach almost 2 m south of
  // Hallway's own floor to be tall enough for Dining Room (its own
  // required neighbour) to fit inside it, well past where Entry's row
  // starts, so the two need real separation, not just the corridor's
  // own width, to stay off each other's walls.
  { name: "Hallway", roomType: "hallway", level: 0, kind: "corridor", rect: [0, 6.65, 3.6, 2.4] },
  { name: "Entry", roomType: "entry", level: 0, rect: [1.2, 9.05, 2.4, 2.4], isEntry: true },
  { name: "Reception", roomType: "reception", level: 0, rect: [1.2, 11.45, 4.5, 5.5] },
  // Exactly Hallway's own height, its minimum -- contains Hallway's full
  // east wall with nothing left over, which is what keeps it clear of
  // Reception's own row (below) rather than reaching into it.
  { name: "Stair", roomType: "stair", level: 0, heightM: 2 * STOREY_HEIGHT_M, rect: [3.6, 6.65, 1.2, 2.4] },

  // ---- ground floor: the household's own chain, room to room ----------
  // Living Room is Hallway's one Private-side spoke; everything else
  // here reaches the house by walking through the room next to it, the
  // way an open plan actually works, not by each having its own
  // corridor door. Dining Room is sized to Diwaniya's own width so its
  // household door is a real, full-length shared wall, not a sliver of
  // one -- not an unusual size for a dining room built to double as
  // overflow seating for the diwaniya's own gatherings. Living Room is
  // sized to match Dining Room's own height for the same reason.
  { name: "Living Room", roomType: "living_room", level: 0, rect: [-4.5, 6.65, 4.5, 4.2] },
  { name: "Dining Room", roomType: "dining_room", level: 0, rect: [-11.0, 6.65, 6.5, 4.2] },
  { name: "Diwaniya", roomType: "diwaniya", level: 0, rect: [-11.0, -1.35, 6.5, 8.0] },
  { name: "Kitchen", roomType: "kitchen", level: 0, rect: [-14.6, 6.65, 3.6, 4.2] },
  // Widened to Dining Room's own left wall (matching it exactly, no
  // sliver of unclaimed floor left between them) rather than the
  // narrower footprint a laundry alone would need.
  { name: "Laundry", roomType: "laundry", level: 0, rect: [-13.7, 10.85, 2.7, 2.4] },
  // Widened to match, so its own east wall reaches Driver Room's -- a
  // deeper mudroom is not an unusual real trade for that.
  { name: "Mudroom", roomType: "mudroom", level: 0, rect: [-13.7, 13.25, 2.7, 2.85] },
  { name: "Garage", roomType: "garage_single", level: 0, rect: [-17.3, 10.85, 3.6, 6.5] },
  { name: "Driver Room", roomType: "driver_room", level: 0, rect: [-11.0, 12.5, 3.3, 3.6] },
  { name: "Driver Bathroom", roomType: "driver_bathroom", level: 0, rect: [-11.0, 16.1, 3.3, 2.4] },

  // ---- first floor: a narrow corridor, only as long as its own doors --
  // Same reasoning as Hallway below it, but for a different, entirely
  // legitimate reason a corridor exists at all: nobody wants to walk
  // through one bedroom to reach another, so each gets its own door here
  // -- kept to the tool's own minimum corridor width (1.2 m) rather than
  // a full room's, so six doors still costs a fraction of the floor.
  // Rooms alternate which side of it they sit on, Master/Bathroom/Nanny
  // south and Bedroom 1/Bedroom 2/Office north, which is also what keeps
  // Nanny Room off both bedrooms' own walls without needing a buffer
  // room between them -- opposite sides of a corridor never touch. The
  // south row starts well clear of Stair's own footprint (below the
  // corridor, same as the south row itself, unlike the north row, which
  // sits above the corridor and so never shares Stair's own strip of it
  // at all -- a real gap here, not a shared wall, since Stair is barely
  // taller than the corridor itself and whatever sits beside it on this
  // side is not).
  { name: "Landing", roomType: "hallway", level: 1, kind: "corridor", rect: [2.4, 5.45, 12.55, 1.2] },
  { name: "Master Bedroom", roomType: "master_bedroom", level: 1, rect: [5.85, 6.65, 4.0, 5.5] },
  // Full width of its owner's own wall -- required, relationships.ts --
  // so its door's t=0.5 lands inside the shared wall regardless of which
  // way `t` runs on that side.
  { name: "Ensuite", roomType: "bathroom", level: 1, rect: [5.85, 12.15, 4.0, 2.7] },
  { name: "Bathroom", roomType: "bathroom", level: 1, rect: [9.85, 6.65, 1.8, 3.0] },
  // nanny_room-bedroom is *both* desired (easy access -- two doors
  // either way, via Landing) *and* undesired (no shared wall) in
  // relationships.ts, the deliberate "close by, never adjoining" reading
  // of where a nanny's own room sits relative to the children's -- Master
  // Bedroom sits between Nanny Room and the corridor's own end on this
  // side, so neither bedroom ever shares a wall with it.
  { name: "Nanny Room", roomType: "nanny_room", level: 1, rect: [11.65, 6.65, 3.3, 4.5] },
  { name: "Nanny Bathroom", roomType: "nanny_bathroom", level: 1, rect: [11.65, 11.15, 3.3, 2.7] },
  { name: "Bedroom 1", roomType: "bedroom", level: 1, rect: [2.4, 0.85, 3.3, 4.6] },
  { name: "Bedroom 2", roomType: "bedroom", level: 1, rect: [5.7, 0.85, 3.3, 4.6] },
  { name: "Office", roomType: "office", level: 1, rect: [9.0, 1.15, 3.0, 4.3] },
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
    door("Entry", 1, { kind: "exterior-main" }),
    door("Diwaniya", 0, { kind: "exterior-side" }),
    door("Garage", 3, { kind: "exterior-side" }),

    // ---- ground floor: Hallway's three spokes ----------------------------
    door("Entry", 0), // Entry <-> Hallway
    door("Entry", 2), // Entry <-> Reception
    door("Hallway", 3), // Hallway <-> Living Room
    door("Hallway", 1), // Hallway <-> Stair

    // ---- ground floor: the household's own chain -------------------------
    door("Dining Room", 0), // Dining Room <-> Diwaniya (the diwaniya's own household door)
    door("Dining Room", 1), // Dining Room <-> Living Room
    door("Kitchen", 1), // Kitchen <-> Dining Room
    door("Laundry", 0), // Laundry <-> Kitchen
    door("Mudroom", 0), // Mudroom <-> Laundry
    door("Mudroom", 3), // Mudroom <-> Garage
    door("Mudroom", 1), // Mudroom <-> Driver Room
    door("Driver Room", 2), // Driver Room <-> Driver Bathroom

    // ---- first floor: Landing's own row of doors -------------------------
    door("Stair", 0, { level: 1 }), // Stair <-> Landing (the same Stair box, its upper door)
    door("Master Bedroom", 0),
    door("Bathroom", 0),
    door("Nanny Room", 0),
    door("Bedroom 1", 2),
    door("Bedroom 2", 2),
    door("Office", 2),

    // ---- first floor: direct doors -----------------------------------------
    door("Master Bedroom", 2), // Master Bedroom <-> Ensuite
    door("Nanny Room", 2), // Nanny Room <-> Nanny Bathroom
  ];
}

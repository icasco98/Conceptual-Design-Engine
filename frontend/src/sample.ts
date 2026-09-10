/**
 * The sample house the editor opens on.
 *
 * Every room is placed by hand, in plan-frame meters, and nothing
 * generates it: the point of this fork is a tool driven by the person
 * drawing, so its starting layout is one a person drew. It is here so
 * that trying the editor never means building a plan from nothing first.
 *
 * Rebuilt a third time around geometry/efficiency.ts's overhang and
 * dead-end-hallway rules, plus three standing asks: the Driver Room gets
 * its own exterior door rather than relying on the household's own, the
 * building's outline runs with as few jogs past a neighbour as a real
 * plan reasonably can, and the Stair is sized like a real single flight
 * rather than the tool's own bare code minimum.
 *
 * - The Stair is 1.2 x 3.9: a straight run, 16 risers at the storey's
 *   3.0 m rise (187.5 mm each, mid code range) and 15 treads at 260 mm
 *   (just past the 254 mm/10 in code floor) -- not the 1.2 x 2.4 a prior
 *   pass shrank it to only to solve a touch-alignment puzzle. Hallway
 *   grew to match its own full 3.9 m height for the same reason
 *   `overhangs` exists at all: two rooms sharing a wall at different
 *   heights is a real jog in the building's outline, priced by the
 *   metre of extra foundation and roof it costs, whether or not a door
 *   is ever cut into it. The run reaches south past Hallway's own south
 *   wall -- Entry (below) shifted down to meet it, which is also what
 *   let Entry widen to Hallway's own full width and close what was
 *   otherwise a real overhang on both of their shared walls.
 * - A second, narrower hallway now serves the service wing (Laundry,
 *   Mudroom, Driver Room, Garage) the same way the household's own
 *   Hallway serves Entry/Living Room/Stair: each a real spoke off one
 *   small corridor, not a serial chain (Kitchen to Laundry to Mudroom to
 *   Garage) that forces walking through every room before it to reach
 *   the last one. Its own door onto Dining Room, not Kitchen, is what
 *   actually keeps a trip to the garage off the kitchen floor; Kitchen
 *   keeps its own door onto the same hallway besides, purely for the
 *   household's own convenience carrying laundry, since a second door
 *   costs nothing once the wall is already shared.
 * - The Driver Room's own street-side door means a driver never has to
 *   route through the household's own Entry (or ring anyone inside) to
 *   come and go -- the same reasoning the diwaniya's own door already
 *   models for a guest.
 * - Upstairs, `deadEndHallways`'s life-safety check reads real walking
 *   distance from a corridor to the farthest room only it reaches, and
 *   stops at the next corridor rather than compounding through one --
 *   see efficiency.ts's own doc comment. Landing's own two ensuite baths
 *   (Master Bedroom's and the Nanny Room's) each keep a second, direct
 *   door onto Landing itself, not only the connecting door to their own
 *   bedroom: a real, common "hall bath with a private connecting door"
 *   shape, and what keeps each suite's own farthest point within the
 *   real ~6 m dead-end-corridor figure common to residential code,
 *   rather than compounding bedroom-depth and bathroom-depth into one
 *   long chain off a single door.
 *
 * The honest cost of building this way rather than gaming the hop count:
 * three `desired` rows this house still cannot cheaply reach in two
 * doors (Driver Room to the Diwaniya; Garage to Entry; a nanny's own
 * quick access to the kitchen or the laundry, both a floor away) are
 * left as the honest, minor recommendations they are, the same as
 * before this rebuild. `scoreCandidate` still reports zero hard
 * problems -- these were never requirements, only nice-to-haves, and a
 * real plan is allowed to not have every nice-to-have.
 *
 * Two storeys, one stair spanning both, its own two doors landing on
 * Hallway and Landing and nothing else. Four exterior doors -- the
 * front door on Entry, the diwaniya's own street door, the garage's own,
 * and now the Driver Room's own -- so the household, a diwaniya guest, a
 * car and a driver each have a door that is actually theirs.
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
  // to Private -- Hallway is that one step. Its own height now matches
  // the Stair's real run exactly (3.9 m, see the file doc comment), so
  // their shared wall is a real match rather than a jog past each other
  // -- growing it also gave Entry (below) room to widen to Hallway's own
  // full width, closing what was otherwise a real overhang on both of
  // their shared walls.
  { name: "Hallway", roomType: "hallway", level: 0, kind: "corridor", rect: [0, 6.65, 3.6, 3.9] },
  // 0.3 m short of Hallway's own left edge on purpose -- Living Room
  // (below) sits directly under Hallway's own west wall, and without
  // this setback Entry's own west wall would reach far enough south to
  // meet Living Room's along a real run, not a single corner point, and
  // `suggestArrows` would hang a door on it: a straight Public-to-Private
  // `tierViolations` failure, two privacy steps at once. Reception
  // (below) narrows to match for the same reason `overhangs` exists at
  // all -- a wall only partly covered is a real jog in the outline.
  { name: "Entry", roomType: "entry", level: 0, rect: [0.3, 10.55, 3.3, 2.4], isEntry: true },
  { name: "Reception", roomType: "reception", level: 0, rect: [0.3, 12.95, 3.5, 5.5] },
  // The run itself: 1.2 wide (a real stair's clear width, not a hallway's
  // own), 3.9 long south from Hallway's own north wall -- a straight
  // flight's real horizontal run for a 3.0 m storey (see the file doc
  // comment for the riser/tread math), matching Hallway's own height
  // exactly so their shared west wall is a real match, not a jog. Its
  // own south wall reaches nothing else in this house (Entry only meets
  // it at a single corner point, not a real shared wall), which is
  // exactly what an ordinary exterior wall looks like -- `overhangs`
  // only flags a wall that is *partly* covered, never one nothing
  // touches at all.
  { name: "Stair", roomType: "stair", level: 0, heightM: 2 * STOREY_HEIGHT_M, rect: [3.6, 6.65, 1.2, 3.9] },

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

  // ---- ground floor: the service wing's own hallway ---------------------
  // Kitchen's own combined width with Dining Room (10.1 m) is exactly
  // this corridor's own width, and the wing below it (Garage, Laundry,
  // Mudroom, Driver Room, in that order) sums to the same 10.1 m --
  // every wall this corridor has is either a real, full shared wall or
  // reaches nothing at all, no jog either way. Its own door onto Dining
  // Room -- not Kitchen -- is what actually keeps a trip to the garage
  // off the kitchen floor; Kitchen keeps a door onto it besides, purely
  // for the household's own convenience carrying laundry, since sharing
  // the wall already costs nothing more.
  { name: "Service Hallway", roomType: "hallway", level: 0, kind: "corridor", rect: [-14.6, 10.85, 10.1, 1.2] },
  { name: "Garage", roomType: "garage_single", level: 0, rect: [-14.6, 12.05, 3.6, 6.5] },
  { name: "Laundry", roomType: "laundry", level: 0, rect: [-11.0, 12.05, 1.8, 2.4] },
  { name: "Mudroom", roomType: "mudroom", level: 0, rect: [-9.2, 12.05, 1.8, 2.1] },
  { name: "Driver Room", roomType: "driver_room", level: 0, rect: [-7.4, 12.05, 2.9, 3.6] },
  { name: "Driver Bathroom", roomType: "driver_bathroom", level: 0, rect: [-7.4, 15.65, 2.9, 2.4] },

  // ---- first floor: a corridor only as long as its own doors ----------
  // Same reasoning as the two ground-floor corridors above: kept to the
  // tool's own minimum width (1.2 m) rather than a full room's. Starts
  // at the Stair's own east wall (7.5, not 4.8) -- the Stair's own real
  // run (see above) reaches that far east on *both* the floor it is
  // drawn on and the one above it, since it is one box spanning both,
  // and nothing on this floor may sit inside that same footprint.
  // Master Bedroom's Ensuite sits *beside* it rather than behind it,
  // with its own separate door onto Landing besides the connecting one
  // -- a real, common "hall bath with a private connecting door" shape,
  // and what keeps the suite's own farthest point within
  // deadEndHallways's real dead-end-corridor limit, rather than
  // compounding bedroom depth and bathroom depth into one long chain off
  // a single door (see the file doc comment). The Nanny suite gets its
  // own short second corridor for the same reason a second corridor
  // exists anywhere in this file: deadEndHallways checks each corridor's
  // own depth separately (efficiency.ts's own doc comment), so a suite
  // two rooms deep stays well within the limit measured from a corridor
  // that starts right at its own front door, rather than compounding
  // onto Landing's own, much longer run.
  { name: "Landing", roomType: "hallway", level: 1, kind: "corridor", rect: [3.6, 5.45, 14.5, 1.2] },
  { name: "Master Bedroom", roomType: "master_bedroom", level: 1, rect: [7.5, 6.65, 4.0, 4.0] },
  { name: "Ensuite", roomType: "bathroom", level: 1, rect: [11.5, 6.65, 1.8, 2.4] },
  { name: "Bathroom", roomType: "bathroom", level: 1, rect: [13.3, 6.65, 1.5, 3.0] },
  // nanny_room-bedroom is *both* desired (easy access -- two doors
  // either way, via Landing and Nanny Hall) *and* undesired (no shared
  // wall) in relationships.ts, the deliberate "close by, never
  // adjoining" reading of where a nanny's own room sits relative to the
  // children's -- the whole Nanny suite sits behind its own corridor
  // off Landing's east end, well clear of every bedroom's own wall.
  // Nanny Room and Nanny Bathroom sit 0.3 m east of Nanny Hall's own
  // footprint -- Bathroom (above) reaches a little deeper south than
  // Nanny Hall does, and without the offset its own wall would reach
  // past Nanny Hall and touch Nanny Room directly, a real shared wall
  // `suggestArrows` would just as readily hang a door on, giving the
  // Nanny suite a second, much shorter route that defeats the whole
  // point of its own corridor.
  { name: "Nanny Hall", roomType: "hallway", level: 1, kind: "corridor", rect: [14.8, 6.65, 3.3, 1.2] },
  { name: "Nanny Room", roomType: "nanny_room", level: 1, rect: [15.1, 7.85, 3.3, 3.3] },
  { name: "Nanny Bathroom", roomType: "nanny_bathroom", level: 1, rect: [15.1, 11.15, 3.3, 1.8] },
  // Centred under Landing's own span rather than flush against Stair --
  // Landing grew considerably east to reach the Nanny suite's own
  // corridor, and centring keeps Bedroom 1 (west) and Office (east)
  // both within deadEndHallways's own real dead-end-corridor limit,
  // rather than leaving the whole row flush west and Office comfortably
  // close while Bedroom 1 reads as too far.
  { name: "Bedroom 1", roomType: "bedroom", level: 1, rect: [6.05, 0.85, 3.3, 4.6] },
  { name: "Bedroom 2", roomType: "bedroom", level: 1, rect: [9.35, 0.85, 3.3, 4.6] },
  { name: "Office", roomType: "office", level: 1, rect: [12.65, 1.15, 3.0, 4.3] },
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
    // ---- exterior doors: the household, a diwaniya guest, a car, a driver --
    door("Entry", 1, { kind: "exterior-main" }),
    door("Diwaniya", 0, { kind: "exterior-side" }),
    door("Garage", 3, { kind: "exterior-side" }),
    door("Driver Room", 1, { kind: "exterior-side" }),

    // ---- ground floor: Hallway's spokes -----------------------------------
    door("Entry", 0), // Entry <-> Hallway
    door("Entry", 2), // Entry <-> Reception
    door("Hallway", 3), // Hallway <-> Living Room
    door("Hallway", 1), // Hallway <-> Stair

    // ---- ground floor: the household's own chain ---------------------------
    door("Dining Room", 0), // Dining Room <-> Diwaniya (the diwaniya's own household door)
    door("Dining Room", 1), // Dining Room <-> Living Room
    door("Kitchen", 1), // Kitchen <-> Dining Room

    // ---- ground floor: Service Hallway's own spokes -------------------------
    door("Kitchen", 2), // Kitchen <-> Service Hallway (the household's own laundry-day shortcut)
    door("Dining Room", 2), // Dining Room <-> Service Hallway (the wing's real route, clear of the kitchen)
    door("Garage", 0), // Garage <-> Service Hallway
    door("Laundry", 0), // Laundry <-> Service Hallway
    door("Mudroom", 0), // Mudroom <-> Service Hallway
    door("Driver Room", 0), // Driver Room <-> Service Hallway
    door("Mudroom", 3), // Laundry <-> Mudroom (direct, besides each's own hallway door)
    door("Driver Room", 2), // Driver Room <-> Driver Bathroom

    // ---- first floor: Landing's own row of doors -----------------------------
    door("Stair", 0, { level: 1 }), // Stair <-> Landing (the same Stair box, its upper door)
    door("Master Bedroom", 0), // Master Bedroom <-> Landing
    door("Ensuite", 3), // Master Bedroom <-> Ensuite (its own connecting door)
    door("Ensuite", 0), // Ensuite <-> Landing (its own separate hall door)
    door("Bathroom", 0), // Bathroom <-> Landing
    door("Nanny Hall", 0), // Nanny Hall <-> Landing
    door("Nanny Room", 0), // Nanny Room <-> Nanny Hall
    door("Nanny Room", 2), // Nanny Room <-> Nanny Bathroom
    door("Bedroom 1", 2),
    door("Bedroom 2", 2),
    door("Office", 2),
  ];
}

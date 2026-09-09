/**
 * The sample house the editor opens on.
 *
 * Every room is placed by hand, in plan-frame meters, and nothing
 * generates it: the point of this fork is a tool driven by the person
 * drawing, so its starting layout is one a person drew. It is here so
 * that trying the editor never means building a plan from nothing first.
 *
 * Two storeys, one stair spanning both floors, and a mix of plain
 * rectangles, one non-convex (L-shaped) room, a chamfered hexagonal
 * diwaniya, and a genuinely rotated bay -- Study downstairs, Bedroom 3
 * above it -- set at 15° and built so its own slanted wall still lands
 * exactly on Dining Room's (and, upstairs, Bedroom 2's) straight east
 * wall: a local edge pre-tilted by -15° becomes axis-aligned once the
 * room's own 15° rotation is applied, the same rotation math the
 * touch-graph itself uses (`frameOf`/`localToPagePoly`), so the two
 * walls coincide on purpose rather than by luck. Five exterior doors --
 * the front door plus the garage's, the utility room's, the diwaniya's
 * and the study's own -- so the household, a delivery and a diwaniya
 * guest each have a door that is actually theirs.
 *
 * "Reset to the sample layout" brings all of this back.
 */
import { newArrowId } from "./geometry/arrows";
import type { Arrow, Box, BoxKind, BoxShape, Point, Plot, Rect } from "./geometry/types";
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
export const SHEET = { width: 30, depth: 20 };

/** The plot a project starts with: the sheet's own rectangle, switched
 *  off. Off is the only honest default — the tool cannot know the site
 *  until someone types it in, and a boundary invented for them would
 *  fence a layout in for no reason. */
export const DEFAULT_PLOT: Plot = { on: false, left: 0, top: 0, width: SHEET.width, depth: SHEET.depth };

/** Where the sample house's own origin sits on the sheet. */
const OX = 6.5;
const OY = 3;

/** The rotated bay's own angle, shared by Study and Bedroom 3 above it. */
const BAY_ROTATION_DEG = 15;

interface Placed {
  name: string;
  roomType: string;
  level: number;
  /** Vertical height when not the storey height; the stair is two tall. */
  heightM?: number;
  rect: [number, number, number, number];
  kind?: BoxKind;
  isEntry?: boolean;
  rotation?: number;
  /** Rect unless given -- a hand-drawn polygon's own corners, as
   * fractions of `rect`, in the same 0..1 scheme `Box.points` always
   * uses. Unset means the plain rectangle. */
  shape?: BoxShape;
  points?: Point[];
}

// Each rect is [left, top, width, height] in meters relative to the house
// origin -- for a rotated room, the rect and its points describe the
// *unrotated* local shape, and `rotation` turns it in place around its own
// centre (frameOf's convention), the same one the touch graph reads. Every
// adjacent pair below shares a wall exactly, so the door arrows and the
// building outline have real edges to find.
const PLACED: Placed[] = [
  // ---- ground floor, main block --------------------------------------
  { name: "Garage", roomType: "garage_single", level: 0, rect: [0, 0, 4.0, 6.0] },
  { name: "Entry", roomType: "entry", level: 0, rect: [4.0, 0, 2.4, 2.4], isEntry: true },
  { name: "Stair", roomType: "stair", level: 0, heightM: 2 * STOREY_HEIGHT_M, rect: [4.0, 2.4, 1.2, 3.6] },
  { name: "Powder Room", roomType: "half_bath", level: 0, rect: [5.2, 2.4, 1.2, 2.0] },
  { name: "Closet", roomType: "closet", level: 0, rect: [5.2, 4.4, 1.2, 1.6] },
  // A non-convex L: the street-facing corner past x=9.5 (local frac
  // 0.674) is left as an open recess rather than square footage, so the
  // room's own outline -- not just its bounding rect -- is what the
  // touch graph and the drawn outline both have to follow.
  {
    name: "Living Room",
    roomType: "living_room",
    level: 0,
    rect: [6.4, 0, 4.6, 6.0],
    shape: "polygon",
    points: [
      [0, 0],
      [0.6739, 0],
      [0.6739, 0.3333],
      [1, 0.3333],
      [1, 1],
      [0, 1],
    ],
  },
  { name: "Utility", roomType: "laundry", level: 0, rect: [0, 6.0, 2.4, 3.5] },
  { name: "Kitchen", roomType: "kitchen", level: 0, rect: [2.4, 6.0, 4.0, 3.5] },
  { name: "Dining Room", roomType: "dining_room", level: 0, rect: [6.4, 6.0, 4.6, 3.5] },
  // The rotated bay: a quadrilateral whose local edge P1-P2 is pre-tilted
  // by -15° so that, once the box's own 15° rotation is applied, that one
  // edge becomes exactly horizontal again -- landing precisely on Dining
  // Room's east wall (page frame (11, 6.0)-(11, 9.5)), while every other
  // edge stays visibly rotated. Verified numerically before writing it
  // here; see the doc comment at the top of this file.
  {
    name: "Study",
    roomType: "office",
    level: 0,
    rect: [10.496, 6.448, 3.906, 3.381],
    rotation: BAY_ROTATION_DEG,
    shape: "polygon",
    points: [
      [0, 0],
      [0.232, 1],
      [1, 1],
      [0.768, 0],
    ],
  },
  // A chamfered hexagon, both street-facing corners cut, with its own
  // door on the flat run between the two cuts rather than on a plain
  // rectangular wall.
  {
    name: "Diwaniya",
    roomType: "diwaniya",
    level: 0,
    rect: [2.4, 9.5, 5.0, 5.6],
    shape: "polygon",
    points: [
      [0, 0],
      [1, 0],
      [1, 0.85],
      [0.8, 1],
      [0.2, 1],
      [0, 0.85],
    ],
  },
  // ---- first floor ----------------------------------------------------
  { name: "Bedroom 1", roomType: "bedroom", level: 1, rect: [0, 0, 4.0, 6.0] },
  { name: "Landing", roomType: "hallway", level: 1, rect: [4.0, 0, 2.4, 2.4], kind: "corridor" },
  { name: "Bathroom", roomType: "bathroom", level: 1, rect: [5.2, 2.4, 1.2, 2.0] },
  { name: "Hall Closet", roomType: "closet", level: 1, rect: [5.2, 4.4, 1.2, 1.6] },
  { name: "Master Bedroom", roomType: "master_bedroom", level: 1, rect: [6.4, 0, 4.6, 3.7] },
  { name: "Ensuite", roomType: "bathroom", level: 1, rect: [6.4, 3.7, 2.3, 2.3] },
  { name: "Walk-in Closet", roomType: "closet", level: 1, rect: [8.7, 3.7, 2.3, 2.3] },
  { name: "Bedroom 2", roomType: "bedroom", level: 1, rect: [6.4, 6.0, 4.6, 3.5] },
  // Directly above Study, the same rotated footprint stacked a floor up
  // -- a real bay window bedroom, not just a rotated bounding box, and
  // its attach edge lands on Bedroom 2's east wall for exactly the same
  // reason Study's lands on Dining Room's.
  {
    name: "Bedroom 3",
    roomType: "bedroom",
    level: 1,
    rect: [10.496, 6.448, 3.906, 3.381],
    rotation: BAY_ROTATION_DEG,
    shape: "polygon",
    points: [
      [0, 0],
      [0.232, 1],
      [1, 1],
      [0.768, 0],
    ],
  },
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
      shape: p.shape ?? "rect",
      points: p.points,
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
      rotation: p.rotation ?? 0,
      priority: kind === "corridor" || p.roomType === "stair" ? CIRCULATION_PRIORITY : DEFAULT_PRIORITY,
      carvedBy: [],
      deleted: false,
      placed: true,
      initial: rect,
    };
  });
}

/** The sample's own placed doors: the front door -- on Entry's
 *  street-facing wall (its top edge) -- plus four side doors, each real
 *  and each serving a different one of the household, a delivery and a
 *  diwaniya guest, rather than all of them sharing the one front door.
 *  Everything else -- the interior doors -- is `suggestArrows` walking
 *  out from the entry the main door marks. */
export function sampleArrows(boxes: Box[]): Arrow[] {
  const byName = (name: string) => boxes.find((b) => b.name === name);
  const entry = byName("Entry");
  if (!entry) return [];
  const arrows: Arrow[] = [{ id: newArrowId(), level: entry.level, hostId: entry.id, side: 0, t: 0.5, dir: 1, kind: "exterior-main" }];
  const garage = byName("Garage");
  // Garage's own left wall, fully exterior along its whole run.
  if (garage) arrows.push({ id: newArrowId(), level: garage.level, hostId: garage.id, side: 3, t: 0.5, dir: 1, kind: "exterior-side" });
  const utility = byName("Utility");
  // Utility's bottom wall: the back-of-house service door.
  if (utility) arrows.push({ id: newArrowId(), level: utility.level, hostId: utility.id, side: 2, t: 0.5, dir: 1, kind: "exterior-side" });
  const diwaniya = byName("Diwaniya");
  // The diwaniya's own flat street run (side 3, between its two chamfered
  // corners) -- a guest's door, never the household's front door.
  if (diwaniya) arrows.push({ id: newArrowId(), level: diwaniya.level, hostId: diwaniya.id, side: 3, t: 0.5, dir: 1, kind: "exterior-side" });
  const study = byName("Study");
  // Study's own outer wall (side 2 of its rotated quadrilateral) -- the
  // face pointed away from the house, not the slanted wall shared with
  // Dining Room.
  if (study) arrows.push({ id: newArrowId(), level: study.level, hostId: study.id, side: 2, t: 0.5, dir: 1, kind: "exterior-side" });
  return arrows;
}

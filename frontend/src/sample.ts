/**
 * The sample house the editor opens on.
 *
 * Every room is placed by hand, in plan-frame meters, and nothing
 * generates it: the point of this fork is a tool driven by the person
 * drawing, so its starting layout is one a person drew. It is here so
 * that trying the editor never means building a plan from nothing first.
 *
 * Two storeys, an 18 × 9.5 m footprint with the rooms directly against
 * each other rather than strung along a corridor, one stair spanning
 * both floors, and the upper floor's own footprint reaching a little
 * short of the ground floor's in a couple of places so the ghost of the
 * level below has something to show.
 *
 * The core 11 × 9.5 m block (Garage through Walk-in Closet) is the
 * original sample and its topology is untouched -- existing tests that
 * name those rooms still hold. Past x = 11 is a second wing, on both
 * floors: a diwaniya downstairs with its own street-facing door, a
 * hand-drawn bay-windowed bedroom above it. Between the two wings, the
 * household keeps three more exterior doors besides the main one -- the
 * garage's own, the utility room's own, and the diwaniya's -- so a
 * majlis guest, deliveries and the household itself each have a door
 * that is actually theirs, not the one shared front door standing in
 * for all of them.
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
const OY = 4;

interface Placed {
  name: string;
  roomType: string;
  level: number;
  /** Vertical height when not the storey height; the stair is two tall. */
  heightM?: number;
  rect: [number, number, number, number];
  kind?: BoxKind;
  isEntry?: boolean;
  /** Rect unless given -- a hand-drawn polygon's own corners, as
   * fractions of `rect`, in the same 0..1 scheme `Box.points` always
   * uses. Unset means the plain rectangle. */
  shape?: BoxShape;
  points?: Point[];
}

// Each rect is [left, top, width, height] in meters relative to the house
// origin. Adjacent rooms share walls exactly, so the door arrows and the
// building outline have real edges to find.
const PLACED: Placed[] = [
  // ---- ground floor, main block --------------------------------------
  { name: "Garage", roomType: "garage_single", level: 0, rect: [0, 0, 3.6, 6.5] },
  { name: "Front Entry", roomType: "entry", level: 0, rect: [3.6, 0, 2.4, 2.4], isEntry: true },
  { name: "Living Room", roomType: "living_room", level: 0, rect: [6.0, 0, 5.0, 5.5] },
  { name: "Powder Room", roomType: "half_bath", level: 0, rect: [3.6, 2.4, 1.2, 2.0] },
  { name: "Pantry", roomType: "closet", level: 0, rect: [3.6, 4.4, 1.2, 2.1] },
  { name: "Stair", roomType: "stair", level: 0, heightM: 2 * STOREY_HEIGHT_M, rect: [4.8, 2.4, 1.2, 4.1] },
  { name: "Dining Room", roomType: "dining_room", level: 0, rect: [6.0, 5.5, 5.0, 4.0] },
  { name: "Utility", roomType: "laundry", level: 0, rect: [0, 6.5, 2.4, 3.0] },
  { name: "Kitchen", roomType: "kitchen", level: 0, rect: [2.4, 6.5, 3.6, 3.0] },
  // ---- ground floor, the diwaniya wing -------------------------------
  // A hand-drawn hexagon, not just its bounding rectangle: the street
  // wall (top) is chamfered at its far corner into a short angled bay,
  // and that angled face -- not the plain top wall -- is where the
  // diwaniya's own door sits (sampleArrows, below). Every other wall is
  // still a plain edge of the 7 x 7.5 m rectangle, so it shares real,
  // fully-aligned walls with Living Room and Dining Room exactly as any
  // rectangular room would.
  {
    name: "Diwaniya",
    roomType: "majlis",
    level: 0,
    rect: [11.0, 0, 7.0, 7.5],
    shape: "polygon",
    points: [
      [0, 0],
      [0.78, 0],
      [1, 0.22],
      [1, 1],
      [0, 1],
    ],
  },
  // ---- first floor ----------------------------------------------------
  { name: "Bedroom 1", roomType: "bedroom", level: 1, rect: [0, 0, 3.6, 4.75] },
  { name: "Bedroom 2", roomType: "bedroom", level: 1, rect: [0, 4.75, 3.6, 4.75] },
  { name: "Landing", roomType: "hallway", level: 1, rect: [3.6, 0, 2.4, 2.4], kind: "corridor" },
  { name: "Hall", roomType: "hallway", level: 1, rect: [3.6, 2.4, 1.2, 4.1], kind: "corridor" },
  { name: "Bathroom", roomType: "bathroom", level: 1, rect: [3.6, 6.5, 2.4, 3.0] },
  { name: "Primary Bedroom", roomType: "bedroom_primary", level: 1, rect: [6.0, 0, 5.0, 4.5] },
  { name: "Ensuite", roomType: "bathroom", level: 1, rect: [6.0, 4.5, 2.6, 3.0] },
  { name: "Walk-in Closet", roomType: "closet", level: 1, rect: [8.6, 4.5, 2.4, 3.0] },
  // ---- first floor, over the diwaniya ----------------------------------
  // A bay-windowed bedroom: both street-facing (top) corners chamfered,
  // a hexagon this time rather than the diwaniya's single-cut pentagon,
  // sized and shaped differently on purpose -- the point is two hand-
  // drawn rooms that do not read as the same shape reused.
  {
    name: "Bedroom 3",
    roomType: "bedroom",
    level: 1,
    rect: [11.0, 0, 7.0, 5.0],
    shape: "polygon",
    points: [
      [0.18, 0],
      [0.82, 0],
      [1, 0.2],
      [1, 1],
      [0, 1],
      [0, 0.2],
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
      rotation: 0,
      priority: kind === "corridor" || p.roomType === "stair" ? CIRCULATION_PRIORITY : DEFAULT_PRIORITY,
      carvedBy: [],
      deleted: false,
      placed: true,
      initial: rect,
    };
  });
}

/** The sample's own placed doors: the front door -- on the Front Entry
 *  zone's street-facing wall (its top edge, where every ground-floor
 *  room starts), the household's one main entrance -- plus three side
 *  doors, each real and each serving a different one of the household,
 *  a majlis guest and a delivery, rather than all three sharing the one
 *  front door. Everything else -- the interior doors -- is
 *  `suggestArrows` walking out from the entry the main door marks. */
export function sampleArrows(boxes: Box[]): Arrow[] {
  const byName = (name: string) => boxes.find((b) => b.name === name);
  const entry = byName("Front Entry");
  if (!entry) return [];
  const arrows: Arrow[] = [{ id: newArrowId(), level: entry.level, hostId: entry.id, side: 0, t: 0.5, dir: 1, kind: "exterior-main" }];
  const garage = byName("Garage");
  // Garage's own left wall, fully exterior along its whole run.
  if (garage) arrows.push({ id: newArrowId(), level: garage.level, hostId: garage.id, side: 3, t: 0.5, dir: 1, kind: "exterior-side" });
  const utility = byName("Utility");
  // Utility's bottom wall: the back-of-house service door.
  if (utility) arrows.push({ id: newArrowId(), level: utility.level, hostId: utility.id, side: 2, t: 0.5, dir: 1, kind: "exterior-side" });
  const diwaniya = byName("Diwaniya");
  // The diwaniya's own chamfered corner (its polygon's side 1) -- a
  // guest's door, on the same street frontage as the main entrance but
  // never the same door.
  if (diwaniya) arrows.push({ id: newArrowId(), level: diwaniya.level, hostId: diwaniya.id, side: 1, t: 0.5, dir: 1, kind: "exterior-side" });
  return arrows;
}

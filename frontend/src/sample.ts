/**
 * The sample house the editor opens on.
 *
 * Every room is placed by hand, in plan-frame meters, and nothing
 * generates it: the point of this fork is a tool driven by the person
 * drawing, so its starting layout is one a person drew. It is here so
 * that trying the editor never means building a plan from nothing first.
 *
 * Two storeys, a compact 11 × 9.5 m footprint with the rooms directly
 * against each other rather than strung along a corridor, the stair on the
 * same rectangle on both floors, and the upper floor a little smaller than
 * the ground floor so the ghost of the level below has something to show.
 *
 * "Reset to the sample layout" brings all of this back.
 */
import type { Box, BoxKind, Rect } from "./geometry/types";
import { roomTypeInfo } from "./rooms";

/** How many storeys the sample has. Rooms are assigned a level; the count
 *  is what the level tabs and the 3D view are built from. */
export const SAMPLE_STOREYS = 2;
/** Floor-to-floor height, meters. */
export const STOREY_HEIGHT_M = 3.0;

/** The drawing sheet. Purely a reference area — a faint rectangle on the
 *  plan and the ground plane under the 3D — and nothing stops a room being
 *  drawn outside it. */
export const SHEET = { width: 24, depth: 18 };

/** Where the sample house's own origin sits on the sheet. */
const OX = 6.5;
const OY = 4;

interface Placed {
  name: string;
  roomType: string;
  level: number;
  rect: [number, number, number, number];
  kind?: BoxKind;
  isEntry?: boolean;
}

// Each rect is [left, top, width, height] in meters relative to the house
// origin. Adjacent rooms share walls exactly, so the door arrows and the
// building outline have real edges to find.
const PLACED: Placed[] = [
  // ---- ground floor -------------------------------------------------
  { name: "Garage", roomType: "garage_single", level: 0, rect: [0, 0, 3.6, 6.5] },
  { name: "Front Entry", roomType: "entry", level: 0, rect: [3.6, 0, 2.4, 2.4], isEntry: true },
  { name: "Living Room", roomType: "living_room", level: 0, rect: [6.0, 0, 5.0, 5.5] },
  { name: "Powder Room", roomType: "half_bath", level: 0, rect: [3.6, 2.4, 1.2, 2.0] },
  { name: "Pantry", roomType: "closet", level: 0, rect: [3.6, 4.4, 1.2, 2.1] },
  { name: "Stair", roomType: "stair", level: 0, rect: [4.8, 2.4, 1.2, 4.1] },
  { name: "Dining Room", roomType: "dining_room", level: 0, rect: [6.0, 5.5, 5.0, 4.0] },
  { name: "Utility", roomType: "laundry", level: 0, rect: [0, 6.5, 2.4, 3.0] },
  { name: "Kitchen", roomType: "kitchen", level: 0, rect: [2.4, 6.5, 3.6, 3.0] },
  // ---- first floor --------------------------------------------------
  { name: "Bedroom 1", roomType: "bedroom", level: 1, rect: [0, 0, 3.6, 4.75] },
  { name: "Bedroom 2", roomType: "bedroom", level: 1, rect: [0, 4.75, 3.6, 4.75] },
  { name: "Landing", roomType: "hallway", level: 1, rect: [3.6, 0, 2.4, 2.4], kind: "corridor" },
  { name: "Hall", roomType: "hallway", level: 1, rect: [3.6, 2.4, 1.2, 4.1], kind: "corridor" },
  { name: "Stair", roomType: "stair", level: 1, rect: [4.8, 2.4, 1.2, 4.1] },
  { name: "Bathroom", roomType: "bathroom", level: 1, rect: [3.6, 6.5, 2.4, 3.0] },
  { name: "Primary Bedroom", roomType: "bedroom_primary", level: 1, rect: [6.0, 0, 5.0, 4.5] },
  { name: "Ensuite", roomType: "bathroom", level: 1, rect: [6.0, 4.5, 2.6, 3.0] },
  { name: "Walk-in Closet", roomType: "closet", level: 1, rect: [8.6, 4.5, 2.4, 3.0] },
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
      roomType: p.roomType,
      isEntry: p.isEntry ?? false,
      level: p.level,
      ...rect,
      // A corridor's minimum is its clear width both ways: it can be any
      // length, but never narrower than a hallway.
      minWidth: kind === "corridor" ? 1.2 : info.minWidth,
      minHeight: kind === "corridor" ? 1.2 : info.minHeight,
      rotation: 0,
      carvedBy: [],
      deleted: false,
      initial: rect,
    };
  });
}

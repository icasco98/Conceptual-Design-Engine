/**
 * What the editor knows about each kind of room: a label, the smallest
 * workable size, and which zone it colours as.
 *
 * The browser is the only place these numbers are read, and this is the
 * only copy of them. Keep it that way: a second copy anywhere is a second
 * thing to hold in step.
 *
 * Minimums are conceptual-design minimums, not code minimums, except
 * where a code fact is stated directly (bathroom 1.5 × 1.75, hallway
 * 1.2 wide). They are what a room can never be carved or resized below.
 * Always confirm against local code during detailed design.
 */
import type { CategoryKey } from "./api/types";

interface RoomTypeInfo {
  label: string;
  minWidth: number;
  minHeight: number;
  typicalWidth: number;
  typicalHeight: number;
  /** Fixed by type: bedrooms private, living shared, garage service. */
  zone: CategoryKey;
}

/** category_a = private, category_b = shared, category_c = service,
 *  category_d = reception (rooms.ts's own doc, api/types.ts's CategoryKey,
 *  explains the fourth one). */
export const ROOM_TYPES: Record<string, RoomTypeInfo> = {
  entry: { label: "Entry / Foyer", minWidth: 1.2, minHeight: 1.2, typicalWidth: 1.8, typicalHeight: 1.8, zone: "category_b" },
  // Sized for floor or perimeter seating rather than furniture groupings,
  // which is why its minimum and typical size both run well past a
  // living room's -- a Gulf diwaniya routinely seats a dozen or more.
  // Its own street-facing door (the arrow tools' side/service entrance)
  // is what actually keeps a majlis guest's circulation out of the
  // household's -- the room type only marks the destination.
  majlis: { label: "Majlis / Diwaniya", minWidth: 4.5, minHeight: 5.5, typicalWidth: 6.5, typicalHeight: 8.0, zone: "category_d" },
  hallway: { label: "Hallway", minWidth: 1.2, minHeight: 2.0, typicalWidth: 1.2, typicalHeight: 3.0, zone: "category_b" },
  living_room: { label: "Living Room", minWidth: 3.5, minHeight: 4.0, typicalWidth: 4.5, typicalHeight: 5.5, zone: "category_b" },
  family_room: { label: "Family Room", minWidth: 3.3, minHeight: 3.6, typicalWidth: 4.2, typicalHeight: 4.8, zone: "category_b" },
  dining_room: { label: "Dining Room", minWidth: 3.0, minHeight: 3.3, typicalWidth: 3.6, typicalHeight: 4.2, zone: "category_b" },
  kitchen: { label: "Kitchen", minWidth: 2.7, minHeight: 3.0, typicalWidth: 3.6, typicalHeight: 4.2, zone: "category_b" },
  bedroom_primary: { label: "Primary Bedroom", minWidth: 3.3, minHeight: 3.6, typicalWidth: 4.0, typicalHeight: 4.5, zone: "category_a" },
  bedroom: { label: "Bedroom", minWidth: 2.7, minHeight: 3.0, typicalWidth: 3.3, typicalHeight: 3.6, zone: "category_a" },
  bathroom: { label: "Bathroom", minWidth: 1.5, minHeight: 1.75, typicalWidth: 1.8, typicalHeight: 2.4, zone: "category_a" },
  half_bath: { label: "Half Bath / Powder Room", minWidth: 0.9, minHeight: 1.5, typicalWidth: 1.1, typicalHeight: 1.6, zone: "category_c" },
  office: { label: "Office / Study", minWidth: 2.4, minHeight: 2.7, typicalWidth: 3.0, typicalHeight: 3.3, zone: "category_a" },
  laundry: { label: "Laundry", minWidth: 1.5, minHeight: 1.8, typicalWidth: 1.8, typicalHeight: 2.4, zone: "category_c" },
  garage_single: { label: "Single Garage", minWidth: 3.0, minHeight: 6.0, typicalWidth: 3.6, typicalHeight: 6.5, zone: "category_c" },
  garage_double: { label: "Double Garage", minWidth: 5.5, minHeight: 6.0, typicalWidth: 6.0, typicalHeight: 6.5, zone: "category_c" },
  closet: { label: "Closet", minWidth: 0.9, minHeight: 0.6, typicalWidth: 1.5, typicalHeight: 0.6, zone: "category_a" },
  storage: { label: "Storage", minWidth: 1.5, minHeight: 1.5, typicalWidth: 2.0, typicalHeight: 2.0, zone: "category_c" },
  mudroom: { label: "Mudroom", minWidth: 1.5, minHeight: 1.8, typicalWidth: 1.8, typicalHeight: 2.1, zone: "category_c" },
  // A straight flight with a landing, sized in plan. Height is the run
  // direction; a 3.0 m storey needs roughly this much.
  stair: { label: "Stair", minWidth: 1.0, minHeight: 2.4, typicalWidth: 1.2, typicalHeight: 3.0, zone: "category_b" },
  other: { label: "Room", minWidth: 2.0, minHeight: 2.0, typicalWidth: 3.0, typicalHeight: 3.0, zone: "category_b" },
};

export const ZONE_LABELS: Record<CategoryKey, string> = {
  category_a: "Private",
  category_b: "Shared",
  category_c: "Service",
  category_d: "Reception",
};

export function roomTypeInfo(roomType: string): RoomTypeInfo {
  return ROOM_TYPES[roomType] ?? ROOM_TYPES.other;
}

export function zoneOf(roomType: string): CategoryKey {
  return roomTypeInfo(roomType).zone;
}

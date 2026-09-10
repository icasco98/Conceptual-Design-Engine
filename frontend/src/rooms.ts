/**
 * What the editor knows about each kind of room: a label, the smallest
 * workable size, which zone it colours as, and two facts used only by the
 * relationship checks (geometry/relationships.ts, geometry/circulation.ts):
 * whether it can be walked *through* to reach somewhere else, and how
 * private it is for the public-to-private gradient check.
 *
 * The browser is the only place these numbers are read, and this is the
 * only copy of them. Keep it that way: a second copy anywhere is a second
 * thing to hold in step.
 *
 * Minimums are conceptual-design minimums, not code minimums, except
 * where a code fact is stated directly (bathroom 1.5 × 1.75, hallway
 * 1.2 wide). They are what a room can never be carved or resized below.
 * Always confirm against local code during detailed design.
 *
 * `tier` is deliberately not derived from `zone`: several types need to
 * diverge (Hallway is Shared by zone but Semi-public by tier; Driver Room
 * is Service by zone but Private by tier), so tier is its own column, set
 * by hand for every type. `undefined` means exempt -- the gradient check
 * skips it entirely. Bathrooms are exempt on purpose: they may open onto
 * either a public or a private zone, so holding them to the gradient rule
 * would be wrong, not just unproven. Service-category rooms (laundry,
 * garage, storage) are exempt for a different reason -- they are not part
 * of the privacy conversation at all.
 */
import type { CategoryKey } from "./api/types";
import type { PrivacyTier, RoomFacts } from "./geometry/types";

interface RoomTypeInfo {
  label: string;
  minWidth: number;
  minHeight: number;
  typicalWidth: number;
  typicalHeight: number;
  /** Fixed by type: bedrooms private, living shared, garage service. */
  zone: CategoryKey;
  /** Can this room type be walked *through* to reach somewhere else?
   * Reachability (geometry/circulation.ts's `reachabilityProblems`) only
   * expands past a room when this is true -- a corridor obviously; a
   * bedroom, a bathroom or a garage never, since a route through one of
   * those is exactly the "only way to X is through the garage" problem
   * the check exists to catch. */
  passable: boolean;
  /** How private this room type is, for the gradient check
   * (geometry/relationships.ts's `tierViolations`) -- not the same axis
   * as `zone`. `undefined` means exempt: the check never flags a door
   * touching this room type either way. */
  tier?: PrivacyTier;
  /** Always entered through exactly one owning room, never an
   * independent stop in circulation -- a bathroom, a closet. Used only
   * by `reachabilityProblems`: an auxiliary room reached solely through
   * one other room is not a "through_room" problem *provided* that other
   * room has a `tier` of its own (public, semi-public or private) -- a
   * bathroom off a bedroom, or off a driver's or nanny's room, is a
   * normal suite; a bathroom off a garage or laundry (no `tier` at all)
   * is still worth flagging. Unset (false) for everything else, including
   * a bedroom or a kitchen: those are real destinations, and being
   * reachable only through one specific other room is exactly the
   * problem this check exists to catch for them. */
  auxiliary?: boolean;
  /** A dedicated movement space -- Entry, Hallway, Mudroom, Stair --
   * rather than a destination room that merely happens to be walkable
   * through (`passable`, above, is the broader set: it also includes
   * Living Room and Dining Room, which are destinations first). Used
   * only by `relationships.ts`'s `stairConnectionProblems`: a stair's
   * door should land on another circulation space, not directly inside
   * a bedroom, kitchen, or any other room that has to serve everyone
   * using the stairs as an involuntary through-route. */
  circulation?: boolean;
  /** Needs supply, waste and vent pipes -- a bathroom, a kitchen, a
   * laundry. Used only by `efficiency.ts`'s `unstackedWetRooms`, and
   * wider than `sanitary`: a kitchen and a laundry have no WC in them
   * and are still on the same plumbing stack. */
  wet?: boolean;
  /** Contains a WC. Used only by `relationships.ts`'s
   * `sanitaryDoorProblems`, and deliberately not the same set as
   * `auxiliary` (a closet is auxiliary and has no WC in it) nor as the
   * Service category (a laundry is Service and has no WC either). The
   * question this answers is narrow and physical: is there a toilet on
   * the other side of this door. */
  sanitary?: boolean;
  /** A room people occupy for long stretches -- sleep, sit, eat, cook,
   * work, receive guests -- which is the set whose comfort and
   * usability `habitability.ts` judges: whether it can cross-ventilate,
   * whether its shape can be furnished. Deliberately not the opposite of
   * `auxiliary` and not "anything with a tier": a hall, a garage, a
   * store, a laundry and a bathroom are all rooms nobody stays in, and
   * a corridor being long and narrow is its job rather than a defect. */
  habitable?: boolean;
  /** Someone sleeps here. The set residential codes require an
   * emergency escape and rescue opening in -- a window or door straight
   * to the outside -- which is what `habitability.ts` checks is even
   * possible. Deliberately narrower than "habitable": an office or a
   * dining room is habitable and may legitimately borrow its light and
   * air from an adjoining room, which this tool cannot see; a bedroom
   * cannot borrow an escape route from anywhere. Staff bedrooms count,
   * for the obvious reason that the person sleeping in one has to be
   * able to get out of it. */
  sleeping?: boolean;
  /** Food is prepared or eaten here. The other half of
   * `sanitaryDoorProblems`' question. A living room is not on this list
   * even though people eat in front of the television: this is about the
   * rooms a plan *designates* for food, which is what the convention is
   * written against. */
  food?: boolean;
}

/** category_a = private, category_b = shared, category_c = service,
 *  category_d = reception (rooms.ts's own doc, api/types.ts's CategoryKey,
 *  explains the fourth one). */
export const ROOM_TYPES: Record<string, RoomTypeInfo> = {
  entry: { label: "Entry / Foyer", minWidth: 1.2, minHeight: 1.2, typicalWidth: 1.8, typicalHeight: 1.8, zone: "category_b", passable: true, tier: "public", circulation: true },
  // Sized for floor or perimeter seating rather than furniture groupings,
  // which is why its minimum and typical size both run well past a
  // living room's -- a Gulf diwaniya routinely seats a dozen or more.
  // Its own street-facing door (the arrow tools' side/service entrance)
  // is what actually keeps a diwaniya guest's circulation out of the
  // household's -- the room type only marks the destination. Public tier:
  // a diwaniya is open to visitors with no prior relationship to the
  // household, which is its whole cultural function.
  diwaniya: { label: "Diwaniya", minWidth: 4.5, minHeight: 5.5, typicalWidth: 6.5, typicalHeight: 8.0, zone: "category_d", passable: false, tier: "public", habitable: true },
  // The general (non-Gulf) equivalent: a room for receiving guests who
  // are female or close family, reached through the main/family entrance
  // rather than a separate door -- unlike the diwaniya, not structurally
  // isolated from the rest of the house.
  reception: { label: "Reception", minWidth: 3.5, minHeight: 4.0, typicalWidth: 4.5, typicalHeight: 5.5, zone: "category_b", passable: false, tier: "public", habitable: true },
  hallway: { label: "Hallway", minWidth: 1.2, minHeight: 2.0, typicalWidth: 1.2, typicalHeight: 3.0, zone: "category_b", passable: true, tier: "semi-public", circulation: true },
  living_room: { label: "Living Room", minWidth: 3.5, minHeight: 4.0, typicalWidth: 4.5, typicalHeight: 5.5, zone: "category_b", passable: true, tier: "private", habitable: true },
  dining_room: { label: "Dining Room", minWidth: 3.0, minHeight: 3.3, typicalWidth: 3.6, typicalHeight: 4.2, zone: "category_b", passable: true, tier: "semi-public", food: true, habitable: true },
  kitchen: { label: "Kitchen", minWidth: 2.7, minHeight: 3.0, typicalWidth: 3.6, typicalHeight: 4.2, zone: "category_b", passable: false, tier: "private", food: true, habitable: true, wet: true },
  master_bedroom: { label: "Master Bedroom", minWidth: 3.3, minHeight: 3.6, typicalWidth: 4.0, typicalHeight: 4.5, zone: "category_a", passable: false, tier: "private", sleeping: true, habitable: true },
  bedroom: { label: "Bedroom", minWidth: 2.7, minHeight: 3.0, typicalWidth: 3.3, typicalHeight: 3.6, zone: "category_a", passable: false, tier: "private", sleeping: true, habitable: true },
  // Bathrooms are exempt from the gradient check on purpose -- see the
  // file doc comment above.
  bathroom: { label: "Bathroom", minWidth: 1.5, minHeight: 1.75, typicalWidth: 1.8, typicalHeight: 2.4, zone: "category_a", passable: false, auxiliary: true, sanitary: true, wet: true },
  half_bath: { label: "Half Bath / Powder Room", minWidth: 0.9, minHeight: 1.5, typicalWidth: 1.1, typicalHeight: 1.6, zone: "category_c", passable: false, auxiliary: true, sanitary: true, wet: true },
  office: { label: "Office / Study", minWidth: 2.4, minHeight: 2.7, typicalWidth: 3.0, typicalHeight: 3.3, zone: "category_a", passable: false, tier: "private", habitable: true },
  laundry: { label: "Laundry", minWidth: 1.5, minHeight: 1.8, typicalWidth: 1.8, typicalHeight: 2.4, zone: "category_c", passable: false, wet: true },
  garage_single: { label: "Single Garage", minWidth: 3.0, minHeight: 6.0, typicalWidth: 3.6, typicalHeight: 6.5, zone: "category_c", passable: false },
  garage_double: { label: "Double Garage", minWidth: 5.5, minHeight: 6.0, typicalWidth: 6.0, typicalHeight: 6.5, zone: "category_c", passable: false },
  closet: { label: "Closet", minWidth: 0.9, minHeight: 0.6, typicalWidth: 1.5, typicalHeight: 0.6, zone: "category_a", passable: false, tier: "private", auxiliary: true },
  storage: { label: "Storage", minWidth: 1.5, minHeight: 1.5, typicalWidth: 2.0, typicalHeight: 2.0, zone: "category_c", passable: false },
  mudroom: { label: "Mudroom", minWidth: 1.5, minHeight: 1.8, typicalWidth: 1.8, typicalHeight: 2.1, zone: "category_c", passable: true, tier: "semi-public", circulation: true },
  // A straight flight with a landing, sized in plan. Height is the run
  // direction; a 3.0 m storey needs roughly this much.
  stair: { label: "Stair", minWidth: 1.0, minHeight: 2.4, typicalWidth: 1.2, typicalHeight: 3.0, zone: "category_b", passable: true, tier: "semi-public", circulation: true },
  // Staff quarters: Service by zone (colour), Private by tier -- the
  // staff member who lives here belongs there and no one else does, same
  // as any other bedroom, even though it's not part of the family's own
  // wing. A live-in maid is modeled as Nanny Room; there is no separate
  // maid type.
  driver_room: { label: "Driver Room", minWidth: 2.7, minHeight: 3.0, typicalWidth: 3.3, typicalHeight: 3.6, zone: "category_c", passable: false, tier: "private", sleeping: true, habitable: true },
  driver_bathroom: { label: "Driver Bathroom", minWidth: 1.5, minHeight: 1.75, typicalWidth: 1.8, typicalHeight: 2.4, zone: "category_c", passable: false, auxiliary: true, sanitary: true, wet: true },
  nanny_room: { label: "Nanny Room", minWidth: 2.7, minHeight: 3.0, typicalWidth: 3.3, typicalHeight: 3.6, zone: "category_c", passable: false, tier: "private", sleeping: true, habitable: true },
  nanny_bathroom: { label: "Nanny Bathroom", minWidth: 1.5, minHeight: 1.75, typicalWidth: 1.8, typicalHeight: 2.4, zone: "category_c", passable: false, auxiliary: true, sanitary: true, wet: true },
  // No bathroom requirement -- it does not need to be ensuite.
  prayer_room: { label: "Prayer Room", minWidth: 2.0, minHeight: 2.5, typicalWidth: 2.5, typicalHeight: 3.0, zone: "category_a", passable: false, tier: "private", habitable: true },
  other: { label: "Room", minWidth: 2.0, minHeight: 2.0, typicalWidth: 3.0, typicalHeight: 3.0, zone: "category_b", passable: false },
};

/** "G" for the ground floor, else the storey number -- the one place
 * this label is decided, so the schedule's own Floor column and any
 * message naming a storey (StatusBar's privacy findings) read the same
 * way. */
export function floorLabel(i: number): string {
  return i === 0 ? "G" : String(i);
}

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

export function passableOf(roomType: string): boolean {
  return roomTypeInfo(roomType).passable;
}

export function tierOf(roomType: string): PrivacyTier | undefined {
  return roomTypeInfo(roomType).tier;
}

export function auxiliaryOf(roomType: string): boolean {
  return !!roomTypeInfo(roomType).auxiliary;
}

export function circulationOf(roomType: string): boolean {
  return !!roomTypeInfo(roomType).circulation;
}

export function sanitaryOf(roomType: string): boolean {
  return !!roomTypeInfo(roomType).sanitary;
}

export function foodOf(roomType: string): boolean {
  return !!roomTypeInfo(roomType).food;
}

export function wetOf(roomType: string): boolean {
  return !!roomTypeInfo(roomType).wet;
}

export function habitableOf(roomType: string): boolean {
  return !!roomTypeInfo(roomType).habitable;
}

export function sleepingOf(roomType: string): boolean {
  return !!roomTypeInfo(roomType).sleeping;
}

/** The whole set, as one object -- what `collectFindings`, `scoreCandidate`
 * and `generateLayout` take. The individual functions above stay exported
 * because the narrower checks still take exactly the one or two they read
 * (`tierViolations` takes `tierOf` alone), and because a caller wanting to
 * answer one question about one room type should not have to assemble a
 * bundle to do it. */
export const ROOM_FACTS: RoomFacts = {
  passable: passableOf,
  tier: tierOf,
  auxiliary: auxiliaryOf,
  circulation: circulationOf,
  sanitary: sanitaryOf,
  food: foodOf,
  wet: wetOf,
  habitable: habitableOf,
  sleeping: sleepingOf,
};

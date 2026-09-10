import { describe, expect, it } from "vitest";

import type { RelationRow } from "./relationships";
import { dimensionRooms, layoutBubbles, topologyLayout, type PlacedRoom, type TopologyRoom } from "./topology";

function room(partial: Partial<TopologyRoom> & { id: string }): TopologyRoom {
  return { roomType: "bedroom", targetAreaM2: 12, minWidth: 2.7, minHeight: 3.0, ...partial };
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Plain axis-aligned rectangle overlap -- every `PlacedRoom` is
 * unrotated, so there is no need to pull in `rect.ts`'s full `Box`-shaped
 * `boxesTrulyIntersect` (and the fields it needs that a `PlacedRoom`
 * doesn't carry) just to check this. Touching edges do not count, same
 * convention as `rect.ts`'s own overlap tests. */
function rectsOverlap(a: PlacedRoom, b: PlacedRoom): boolean {
  const eps = 1e-6;
  return a.left + eps < b.left + b.width && b.left + eps < a.left + a.width && a.top + eps < b.top + b.height && b.top + eps < a.top + a.height;
}

describe("layoutBubbles: the topology stage's force-directed bubble diagram", () => {
  it("settles with a required-adjacency pair closer together than an unconnected pair", () => {
    const rooms: TopologyRoom[] = [
      room({ id: "kitchen", roomType: "kitchen", targetAreaM2: 15 }),
      room({ id: "dining", roomType: "dining_room", targetAreaM2: 12 }),
      room({ id: "office", roomType: "office", targetAreaM2: 8 }),
      room({ id: "bathroom", roomType: "bathroom", targetAreaM2: 4, minWidth: 1.5, minHeight: 1.75 }),
    ];
    // kitchen/dining_room is `required` in relationships.ts's own base
    // rows; office and bathroom have no row connecting them to anything
    // here, so they're the "unconnected" control.
    const bubbles = layoutBubbles(rooms);
    const byId = new Map(bubbles.map((b) => [b.id, b]));
    const connected = dist(byId.get("kitchen")!, byId.get("dining")!);
    const unconnectedA = dist(byId.get("kitchen")!, byId.get("office")!);
    const unconnectedB = dist(byId.get("kitchen")!, byId.get("bathroom")!);
    expect(connected).toBeLessThan(unconnectedA);
    expect(connected).toBeLessThan(unconnectedB);
  });

  it("never lands two centres on top of each other", () => {
    const rooms: TopologyRoom[] = Array.from({ length: 8 }, (_, i) => room({ id: `r${i}`, roomType: i % 2 ? "bedroom" : "office", targetAreaM2: 10 + i }));
    const bubbles = layoutBubbles(rooms);
    for (let i = 0; i < bubbles.length; i++) {
      for (let j = i + 1; j < bubbles.length; j++) {
        expect(dist(bubbles[i], bubbles[j])).toBeGreaterThan(1e-6);
      }
    }
  });

  it("is deterministic -- same rooms in, same centres out, every time", () => {
    const rooms: TopologyRoom[] = [
      room({ id: "a", roomType: "kitchen", targetAreaM2: 15 }),
      room({ id: "b", roomType: "dining_room", targetAreaM2: 12 }),
      room({ id: "c", roomType: "bedroom", targetAreaM2: 11 }),
    ];
    expect(layoutBubbles(rooms)).toEqual(layoutBubbles(rooms));
  });

  it("handles a single room and an empty list without special-casing by the caller", () => {
    expect(layoutBubbles([])).toEqual([]);
    const one = layoutBubbles([room({ id: "solo" })]);
    expect(one).toHaveLength(1);
    expect(Number.isFinite(one[0].x)).toBe(true);
    expect(Number.isFinite(one[0].y)).toBe(true);
  });

  it("gets no attraction from an undesired-only row, only the batch 003 repulsion boost", () => {
    const rooms: TopologyRoom[] = [room({ id: "a", roomType: "bedroom" }), room({ id: "b", roomType: "garage_single", targetAreaM2: 20 })];
    const rules: RelationRow[] = [{ a: "bedroom", b: "garage_single", relation: "undesired" }];
    const withRule = layoutBubbles(rooms, rules);
    const withoutRule = layoutBubbles(rooms, []);
    // Batch 002: an undesired row was not modelled at all, so `withRule`
    // and `withoutRule` settled identically. Batch 003, Task 2, adds real
    // extra repulsion for it (`buildUndesiredPairs`), which is expected to
    // change the settle -- so this no longer asserts equality, it asserts
    // the *direction* of the change: strictly farther apart, never closer,
    // which is what "repulsion, never attraction" on an undesired row
    // means in practice.
    expect(dist(withRule[0], withRule[1])).toBeGreaterThan(dist(withoutRule[0], withoutRule[1]));
  });

  it("pushes an undesired pair farther apart than an unconnected pair of the same sizes (Task 2, batch 003)", () => {
    const undesiredRooms: TopologyRoom[] = [
      room({ id: "a", roomType: "bedroom", targetAreaM2: 12 }),
      room({ id: "b", roomType: "kitchen", targetAreaM2: 15 }),
    ];
    const undesiredRules: RelationRow[] = [{ a: "bedroom", b: "kitchen", relation: "undesired" }];
    const unconnectedRooms: TopologyRoom[] = [
      room({ id: "a", roomType: "bedroom", targetAreaM2: 12 }),
      room({ id: "b", roomType: "office", targetAreaM2: 15 }),
    ];
    const undesiredBubbles = layoutBubbles(undesiredRooms, undesiredRules);
    const unconnectedBubbles = layoutBubbles(unconnectedRooms, []);
    const undesiredDist = dist(undesiredBubbles[0], undesiredBubbles[1]);
    const unconnectedDist = dist(unconnectedBubbles[0], unconnectedBubbles[1]);
    expect(undesiredDist).toBeGreaterThan(unconnectedDist);
  });

  it("settles a private-tier room farther from the entry than a public-tier one (Task 3, batch 003)", () => {
    const rooms: TopologyRoom[] = [
      room({ id: "entry", roomType: "entry", targetAreaM2: 3, minWidth: 1.2, minHeight: 1.2, isEntryPoint: true, tier: "public" }),
      room({ id: "living", roomType: "living_room", targetAreaM2: 18, tier: "public" }),
      room({ id: "bedroom", roomType: "bedroom", targetAreaM2: 12, tier: "private" }),
    ];
    const bubbles = layoutBubbles(rooms);
    const byId = new Map(bubbles.map((b) => [b.id, b]));
    const entry = byId.get("entry")!;
    const publicDist = dist(entry, byId.get("living")!);
    const privateDist = dist(entry, byId.get("bedroom")!);
    expect(privateDist).toBeGreaterThan(publicDist);
  });

  it("biases nothing when no room declares itself the entry point -- existing callers are unaffected", () => {
    const rooms: TopologyRoom[] = [
      room({ id: "a", roomType: "living_room", targetAreaM2: 18, tier: "public" }),
      room({ id: "b", roomType: "bedroom", targetAreaM2: 12, tier: "private" }),
    ];
    const withTiers = layoutBubbles(rooms);
    const withoutTiers = layoutBubbles(rooms.map((r) => ({ ...r, tier: undefined })));
    expect(withTiers).toEqual(withoutTiers);
  });
});

describe("dimensionRooms: the dimensioning stage's area partition", () => {
  const boundary = { left: 0, top: 0, width: 20, height: 16 };

  it("produces non-overlapping, boundary-respecting rectangles for a required-adjacency pair that end up sharing a real wall", () => {
    const rooms: TopologyRoom[] = [
      room({ id: "kitchen", roomType: "kitchen", targetAreaM2: 15, minWidth: 2.7, minHeight: 3.0 }),
      room({ id: "dining", roomType: "dining_room", targetAreaM2: 12, minWidth: 3.0, minHeight: 3.3 }),
      room({ id: "bed1", roomType: "bedroom", targetAreaM2: 11 }),
      room({ id: "bed2", roomType: "bedroom", targetAreaM2: 11 }),
      room({ id: "office", roomType: "office", targetAreaM2: 8, minWidth: 2.4, minHeight: 2.7 }),
    ];
    const placed = topologyLayout(rooms, boundary);
    expect(placed).toHaveLength(rooms.length);

    for (const p of placed) {
      expect(p.left).toBeGreaterThanOrEqual(boundary.left - 1e-9);
      expect(p.top).toBeGreaterThanOrEqual(boundary.top - 1e-9);
      expect(p.left + p.width).toBeLessThanOrEqual(boundary.left + boundary.width + 1e-9);
      expect(p.top + p.height).toBeLessThanOrEqual(boundary.top + boundary.height + 1e-9);
    }

    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(rectsOverlap(placed[i], placed[j])).toBe(false);
      }
    }

    // The required pair should end up flush -- a real touching wall, the
    // whole point of running a bubble diagram before slicing -- and not
    // merely "somewhere on the same plot" the way a naive shelf pack would
    // have left them.
    const kitchen = placed.find((p) => p.id === "kitchen")!;
    const dining = placed.find((p) => p.id === "dining")!;
    const touchingX = Math.abs(kitchen.left + kitchen.width - dining.left) < 1e-6 || Math.abs(dining.left + dining.width - kitchen.left) < 1e-6;
    const touchingY = Math.abs(kitchen.top + kitchen.height - dining.top) < 1e-6 || Math.abs(dining.top + dining.height - kitchen.top) < 1e-6;
    const xOverlap = Math.min(kitchen.left + kitchen.width, dining.left + dining.width) - Math.max(kitchen.left, dining.left);
    const yOverlap = Math.min(kitchen.top + kitchen.height, dining.top + dining.height) - Math.max(kitchen.top, dining.top);
    expect((touchingX && yOverlap > 0) || (touchingY && xOverlap > 0)).toBe(true);
  });

  it("gives every room at least its own minimum footprint's worth of area when the plot has room to spare", () => {
    const rooms: TopologyRoom[] = [
      room({ id: "a", roomType: "kitchen", targetAreaM2: 15, minWidth: 2.7, minHeight: 3.0 }),
      room({ id: "b", roomType: "bathroom", targetAreaM2: 4, minWidth: 1.5, minHeight: 1.75 }),
      room({ id: "c", roomType: "bedroom", targetAreaM2: 11, minWidth: 2.7, minHeight: 3.0 }),
    ];
    const placed = topologyLayout(rooms, { left: 0, top: 0, width: 12, height: 12 });
    for (const p of placed) {
      const r = rooms.find((r) => r.id === p.id)!;
      expect(p.width * p.height).toBeGreaterThanOrEqual(r.minWidth * r.minHeight - 1e-6);
    }
  });

  it("handles a single room by giving it the whole boundary", () => {
    const placed = topologyLayout([room({ id: "only" })], boundary);
    expect(placed).toEqual([{ id: "only", left: boundary.left, top: boundary.top, width: boundary.width, height: boundary.height }]);
  });

  it("is a no-op on an empty room list", () => {
    expect(topologyLayout([], boundary)).toEqual([]);
  });

  it("prefers a boundary-touching slice for a room that needs an exterior wall (Task 4, batch 003)", () => {
    // A 4x3 grid of 12 equal-weight rooms -- enough recursion depth for
    // slice-and-dice to produce at least one fully interior leaf (touching
    // none of the plot's own four sides), the case this task exists to
    // repair. Bubble positions are supplied directly rather than run
    // through `layoutBubbles`, so the partition this test checks is
    // exactly reproducible regardless of anything the force simulation
    // does.
    const gridBoundary = { left: 0, top: 0, width: 100, height: 100 };
    const rooms: TopologyRoom[] = Array.from({ length: 12 }, (_, i) => room({ id: `r${i}`, targetAreaM2: 10, minWidth: 2, minHeight: 2 }));
    const bubbles = rooms.map((r, i) => ({ id: r.id, roomType: r.roomType, x: (i % 4) * 10, y: Math.floor(i / 4) * 10, radius: 1 }));

    const touches = (p: PlacedRoom) =>
      Math.abs(p.left - gridBoundary.left) < 0.01 ||
      Math.abs(p.top - gridBoundary.top) < 0.01 ||
      Math.abs(p.left + p.width - (gridBoundary.left + gridBoundary.width)) < 0.01 ||
      Math.abs(p.top + p.height - (gridBoundary.top + gridBoundary.height)) < 0.01;

    // Control: nobody needs an exterior wall, so nothing should be swapped
    // -- find a room the plain area partition left fully interior.
    const control = dimensionRooms(rooms, bubbles, gridBoundary);
    const interior = control.find((p) => !touches(p));
    expect(interior).toBeDefined(); // the grid is built specifically to produce one

    // Same rooms, same bubbles, only that one room now flagged as needing
    // an exterior wall -- it should end up on a boundary-touching slice
    // instead, by trading places with some other, non-needing room that
    // was already on one.
    const withNeed = rooms.map((r) => (r.id === interior!.id ? { ...r, needsExterior: true } : r));
    const repaired = dimensionRooms(withNeed, bubbles, gridBoundary);
    const repairedRoom = repaired.find((p) => p.id === interior!.id)!;
    expect(touches(repairedRoom)).toBe(true);

    // The repair must never break the partition's own guarantees: still
    // exactly tiling, still no overlap, whichever rooms ended up where.
    const total = repaired.reduce((s, p) => s + p.width * p.height, 0);
    expect(total).toBeCloseTo(gridBoundary.width * gridBoundary.height, 6);
    for (let i = 0; i < repaired.length; i++) {
      for (let j = i + 1; j < repaired.length; j++) {
        expect(rectsOverlap(repaired[i], repaired[j])).toBe(false);
      }
    }
  });

  it("leaves a needing room unmet rather than forcing it when nothing else is available to trade", () => {
    // A single room, alone with the whole boundary: it already touches
    // every side there is, so the repair pass has nothing to do and
    // nothing to report as a failure either.
    const placed = dimensionRooms([room({ id: "only", needsExterior: true })], [{ id: "only", roomType: "bedroom", x: 0, y: 0, radius: 1 }], boundary);
    expect(placed).toEqual([{ id: "only", left: boundary.left, top: boundary.top, width: boundary.width, height: boundary.height }]);
  });

  it("tiles the boundary exactly -- every rectangle's total area sums to the plot's own", () => {
    const rooms: TopologyRoom[] = Array.from({ length: 6 }, (_, i) => room({ id: `r${i}`, targetAreaM2: 8 + i * 2 }));
    const placed = dimensionRooms(rooms, layoutBubbles(rooms), boundary);
    const total = placed.reduce((s, p) => s + p.width * p.height, 0);
    expect(total).toBeCloseTo(boundary.width * boundary.height, 6);
  });
});

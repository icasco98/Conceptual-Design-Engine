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

  it("only pulls on required/desired rows -- an undesired-only pair behaves like two unconnected rooms", () => {
    const rooms: TopologyRoom[] = [room({ id: "a", roomType: "bedroom" }), room({ id: "b", roomType: "garage_single", targetAreaM2: 20 })];
    const rules: RelationRow[] = [{ a: "bedroom", b: "garage_single", relation: "undesired" }];
    const withRule = layoutBubbles(rooms, rules);
    const withoutRule = layoutBubbles(rooms, []);
    // Same starting spiral, same (absent) attraction either way -- an
    // undesired row that this stage doesn't model at all should produce
    // exactly the same settle as no row at all.
    expect(withRule).toEqual(withoutRule);
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

  it("tiles the boundary exactly -- every rectangle's total area sums to the plot's own", () => {
    const rooms: TopologyRoom[] = Array.from({ length: 6 }, (_, i) => room({ id: `r${i}`, targetAreaM2: 8 + i * 2 }));
    const placed = dimensionRooms(rooms, layoutBubbles(rooms), boundary);
    const total = placed.reduce((s, p) => s + p.width * p.height, 0);
    expect(total).toBeCloseTo(boundary.width * boundary.height, 6);
  });
});

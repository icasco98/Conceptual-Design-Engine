import { describe, expect, it } from "vitest";

import { carvePlanFor, CarveContext, displayShapes } from "./carve";
import { doorArrows, touchingEdge } from "./doors";
import { footprintRings } from "./footprint";
import { polyArea } from "./poly";
import { boxesTrulyIntersect, obbPenetration, obbOf, obbsSeparated } from "./rect";
import { clampPositionOnly, resolveOverlaps, rotationIsAllowed, snapToGrid, snapToNearbyNeighbors } from "./resolve";
import { applyRotations, normaliseAngle, rotationReport } from "./rotate";
import { shaftsPiercing, stairShafts } from "./shafts";
import type { Box, Envelope } from "./types";

function box(partial: Partial<Box> & { id: string; left: number; top: number; width: number; height: number }): Box {
  return {
    name: partial.id,
    kind: "room",
    roomType: "bedroom",
    isEntry: false,
    level: 0,
    minWidth: 2.7,
    minHeight: 3.0,
    rotation: 0,
    deleted: false,
    initial: { left: partial.left, top: partial.top, width: partial.width, height: partial.height },
    ...partial,
  };
}

const ENV: Envelope = { left: 0, top: 0, right: 20, bottom: 20 };

describe("oriented boxes", () => {
  it("rotated squares near each other are separated even when their bounding boxes overlap", () => {
    // A diamond (4x4 at 45deg, centred on (2,2), reaching 2.83 from centre)
    // and a square whose corner sits in the diamond's bounding box but
    // outside the diamond itself: |3.5-2| + |3.5-2| = 3 > 2.83.
    const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4, rotation: 45 });
    const b = box({ id: "b", left: 3.5, top: 3.5, width: 4, height: 4 });
    expect(obbsSeparated(obbOf(a), obbOf(b))).toBe(true);
    expect(boxesTrulyIntersect(a, b)).toBe(false);
    // Slide the square in and they meet for real.
    expect(boxesTrulyIntersect(a, { ...b, left: 2.8, top: 2.8 })).toBe(true);
  });

  it("penetration is along the shallowest axis and just clears the pair", () => {
    const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4 });
    const b = box({ id: "b", left: 3.5, top: 0.2, width: 4, height: 4 });
    const mtv = obbPenetration(obbOf(a), obbOf(b))!;
    // 0.5 of overlap, plus enough to clear the tolerance obbsSeparated uses.
    expect(mtv[0]).toBeCloseTo(-0.504, 5);
    expect(mtv[1]).toBeCloseTo(0, 5);
    const moved = { ...a, left: a.left + mtv[0], top: a.top + mtv[1] };
    expect(obbsSeparated(obbOf(moved), obbOf(b))).toBe(true);
  });
});

describe("carving", () => {
  it("a room gives up a corner to a rotated neighbour and keeps its minimum", () => {
    const victim = box({ id: "v", left: 0, top: 0, width: 5, height: 5 });
    const biter = box({ id: "b", left: 4, top: 4, width: 3, height: 3, rotation: 30 });
    const ctx = new CarveContext("b");
    expect(ctx.chooseBiteVictim(victim, biter)?.id).toBe("v");
    const plan = carvePlanFor(victim, [victim, biter], ctx);
    expect(plan.taking.map((b) => b.id)).toEqual(["b"]);
    expect(polyArea(plan.poly)).toBeLessThan(25);
    expect(polyArea(plan.poly)).toBeGreaterThan(2.7 * 3.0);
  });

  it("a bathroom at its minimum cannot absorb anything, so the pair is pushed", () => {
    const bath = box({ id: "bath", left: 5, top: 5, width: 1.8, height: 2.4, minWidth: 1.5, minHeight: 1.75 });
    const bed = box({ id: "bed", left: 6.0, top: 5.5, width: 3.3, height: 3.6 });
    const ctx = new CarveContext("bed");
    // The bed is pinned so the bath should give way, but it can't; the
    // bed isn't asked to (it's pinned) -> nobody.
    expect(ctx.chooseBiteVictim(bath, bed)).toBeNull();
    const resolved = resolveOverlaps([bath, bed], "bed", ENV);
    const movedBath = resolved.find((b) => b.id === "bath")!;
    expect(movedBath.left).toBeCloseTo(4.2);
    expect(resolved.find((b) => b.id === "bed")).toEqual(bed);
    expect(boxesTrulyIntersect(movedBath, bed)).toBe(false);
  });

  it("a room with nowhere to go is left overlapping rather than shoved through the setback", () => {
    const bath = box({ id: "bath", left: 0, top: 0, width: 1.8, height: 2.4, minWidth: 1.5, minHeight: 1.75 });
    const bed = box({ id: "bed", left: 1.0, top: 0.5, width: 3.3, height: 3.6 });
    const resolved = resolveOverlaps([bath, bed], "bed", ENV);
    expect(resolved.find((b) => b.id === "bath")!.left).toBeCloseTo(0);
  });

  it("corridors never move and never get eaten", () => {
    const hall = box({ id: "hall", kind: "corridor", roomType: "hallway", left: 0, top: 5, width: 12, height: 1.2, minWidth: 1.2, minHeight: 1.2 });
    const bed = box({ id: "bed", left: 2, top: 5.7, width: 3.3, height: 3.6 });
    const resolved = resolveOverlaps([hall, bed], "bed", ENV);
    expect(resolved.find((b) => b.id === "hall")).toEqual(hall);
    // The bed is pinned too, so nothing moved; the bed draws itself carved.
    const shapes = displayShapes([hall, bed], "bed");
    const bedShape = shapes.find((s) => s.id === "bed")!;
    expect(bedShape.carved).toBe(true);
    expect(polyArea(bedShape.page)).toBeCloseTo(3.3 * 3.6 - 3.3 * 0.5, 3);
  });

  it("a permitted rotation still has to be resolved, or the overlap just stands", () => {
    // The reported case: a living room turned 45 degrees onto two neighbours
    // that cannot both give way. rotationIsAllowed asks pair by pair whether
    // SOME victim could be chosen and says yes; carvePlanFor, which the
    // drawing uses, weighs all of a room's cuts together and refuses. The
    // rotate gesture used to trust the first answer and skip resolveOverlaps,
    // leaving rooms drawn on top of each other.
    const living = box({ id: "living", left: 6, top: 6, width: 4.7, height: 4.7, rotation: 45 });
    const driver = box({ id: "driver", left: 4.2, top: 8.2, width: 3.0, height: 3.2, minWidth: 2.8, minHeight: 3.0 });
    const laundry = box({ id: "laundry", left: 4.4, top: 5.4, width: 2.8, height: 2.4, minWidth: 2.6, minHeight: 2.2 });
    const live = [living, driver, laundry];

    expect(rotationIsAllowed([living], live)).toBe(true);

    const settled = resolveOverlaps(live, "living", ENV);
    const turned = settled.find((b) => b.id === "living")!;
    expect(turned.left).toBe(living.left);
    expect(turned.top).toBe(living.top);

    // Whatever could not be carved has been pushed clear: nothing is left
    // sitting inside the turned room's true, rotated shape.
    for (const other of settled.filter((b) => b.id !== "living")) {
      expect(boxesTrulyIntersect(turned, other)).toBe(false);
    }
  });

  it("a rotation that would need a refused bite is not allowed", () => {
    const bath = box({ id: "bath", left: 5, top: 5, width: 1.8, height: 2.4, minWidth: 1.5, minHeight: 1.75 });
    const bed = box({ id: "bed", left: 5.5, top: 6, width: 3.3, height: 3.6, rotation: 40 });
    expect(rotationIsAllowed([bed], [bath, bed])).toBe(false);
  });
});

describe("snapping and clamping", () => {
  it("grid snaps to 0.25m", () => {
    expect(snapToGrid(1.13)).toBeCloseTo(1.25);
    expect(snapToGrid(1.12)).toBeCloseTo(1.0);
  });

  it("a small gap to a facing neighbour closes", () => {
    const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4 });
    const b = box({ id: "b", left: 4.6, top: 1, width: 3, height: 3 });
    const snapped = snapToNearbyNeighbors(b, [a, b]);
    expect(snapped.left).toBeCloseTo(4.0);
  });

  it("a box past the setback line is moved back, not shrunk", () => {
    const a = box({ id: "a", left: 18, top: -1, width: 4, height: 4 });
    const c = clampPositionOnly(a, ENV);
    expect(c.left).toBeCloseTo(16);
    expect(c.top).toBeCloseTo(0);
    expect(c.width).toBe(4);
  });
});

describe("doors and footprint", () => {
  it("touching edges are found along shared walls only, never corners", () => {
    expect(touchingEdge({ left: 0, top: 0, width: 4, height: 4 }, { left: 4, top: 1, width: 3, height: 3 }, 0.04)?.axis).toBe("x");
    expect(touchingEdge({ left: 0, top: 0, width: 4, height: 4 }, { left: 4, top: 4, width: 3, height: 3 }, 0.04)).toBeNull();
  });

  it("arrows walk from the entry, or from the stair on an upper level", () => {
    const entry = box({ id: "e", isEntry: true, roomType: "entry", left: 0, top: 0, width: 2, height: 4 });
    const hall = box({ id: "h", kind: "corridor", roomType: "hallway", left: 0, top: 4, width: 10, height: 1.2 });
    const bed = box({ id: "b", left: 4, top: 5.2, width: 3.3, height: 3.6 });
    expect(doorArrows([entry, hall, bed])).toHaveLength(2);
    const stair = box({ id: "s", roomType: "stair", left: 0, top: 0, width: 1.2, height: 4, level: 1 });
    expect(doorArrows([stair, { ...hall, level: 1 }, { ...bed, level: 1 }])).toHaveLength(2);
    expect(doorArrows([{ ...hall, level: 1 }, { ...bed, level: 1 }])).toHaveLength(0);
  });

  it("the outline is one ring around touching boxes", () => {
    const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4 });
    const b = box({ id: "b", left: 4, top: 0, width: 4, height: 4 });
    const rings = footprintRings(displayShapes([a, b], null).map((s) => s.page));
    expect(rings).toHaveLength(1);
    expect(polyArea(rings[0])).toBeCloseTo(32);
  });
});

describe("vertical circulation", () => {
  const stairOn = (level: number) =>
    box({ id: `room:${level}:Stair`, name: "Stair", roomType: "stair", left: 1.5, top: 2, width: 1.2, height: 5, level });

  it("a stair on every storey is one shaft, not one box per storey", () => {
    const boxes = [stairOn(0), stairOn(1), stairOn(2), box({ id: "bed", left: 8, top: 2, width: 3, height: 4, level: 1 })];
    const shafts = stairShafts(boxes, 3);
    expect(shafts).toHaveLength(1);
    expect(shafts[0].from).toBe(0);
    expect(shafts[0].to).toBe(2);
  });

  it("a stair that stops short only spans the storeys it connects", () => {
    const shafts = stairShafts([stairOn(1), stairOn(2)], 3);
    expect(shafts[0].from).toBe(1);
    expect(shafts[0].to).toBe(2);
  });

  it("two stairs stay two shafts", () => {
    const other = box({ id: "room:0:Back Stair", name: "Back Stair", roomType: "stair", left: 12, top: 2, width: 1.2, height: 5 });
    expect(stairShafts([stairOn(0), stairOn(1), other], 2)).toHaveLength(2);
  });

  it("a shaft pierces the floors above its base, and stands on its own", () => {
    const shafts = stairShafts([stairOn(0), stairOn(1), stairOn(2)], 3);
    expect(shaftsPiercing(shafts, 0)).toHaveLength(0);
    expect(shaftsPiercing(shafts, 1)).toHaveLength(1);
    expect(shaftsPiercing(shafts, 2)).toHaveLength(1);
    expect(shaftsPiercing(shafts, 3)).toHaveLength(0);
  });
});

describe("rotation asked for in words", () => {
  it("snaps to the same 5 degrees the rotate handle uses, and wraps", () => {
    expect(normaliseAngle(43)).toBe(45);
    expect(normaliseAngle(-45)).toBe(315);
    expect(normaliseAngle(360)).toBe(0);
    expect(normaliseAngle(722)).toBe(0);
  });

  it("turns a room that has the space for it", () => {
    const boxes = [box({ id: "a", name: "Office", left: 2, top: 2, width: 3, height: 3 })];
    const out = applyRotations(boxes, [{ room_name: "office", degrees: 45 }], ENV, 1);
    expect(out.applied).toEqual([{ name: "Office", degrees: 45, wanted: 45 }]);
    expect(out.boxes[0].rotation).toBe(45);
    expect(out.refused).toEqual([]);
  });

  it("goes as far as it can when the whole turn will not fit", () => {
    // Room enough to start turning, not enough to reach 90.
    const boxes = [
      box({ id: "a", name: "Office", left: 4, top: 4, width: 3, height: 3 }),
      box({ id: "n", name: "North", left: 4, top: 0.4, width: 3, height: 3, minWidth: 3, minHeight: 3 }),
      box({ id: "s", name: "South", left: 4, top: 7.6, width: 3, height: 3, minWidth: 3, minHeight: 3 }),
    ];
    const out = applyRotations(boxes, [{ room_name: "Office", degrees: 90 }], ENV, 1);
    // Either it got all the way or it stopped short — but it must have
    // moved, and it must report the angle it actually holds.
    expect(out.refused).toEqual([]);
    expect(out.applied[0].wanted).toBe(90);
    expect(out.boxes.find((b) => b.id === "a")!.rotation).toBe(out.applied[0].degrees);
  });

  it("refuses a room boxed in, and leaves it exactly as it was", () => {
    // Three rooms at their minimum, packed tight: nothing can give up a corner.
    const mid = box({ id: "mid", name: "Office", left: 4, top: 4, width: 2.7, height: 3, minWidth: 2.7, minHeight: 3 });
    const boxes = [
      mid,
      box({ id: "l", name: "Left", left: 1.3, top: 4, width: 2.7, height: 3, minWidth: 2.7, minHeight: 3 }),
      box({ id: "r", name: "Right", left: 6.7, top: 4, width: 2.7, height: 3, minWidth: 2.7, minHeight: 3 }),
    ];
    const out = applyRotations(boxes, [{ room_name: "Office", degrees: 45 }], ENV, 1);
    expect(out.applied).toEqual([]);
    expect(out.refused).toEqual(["Office"]);
    expect(out.boxes).toEqual(boxes);
  });

  it("names a room the project does not have rather than failing silently", () => {
    const out = applyRotations([box({ id: "a", name: "Office", left: 2, top: 2, width: 3, height: 3 })],
      [{ room_name: "Ballroom", degrees: 45 }], ENV, 1);
    expect(out.unknown).toEqual(["Ballroom"]);
    expect(out.applied).toEqual([]);
  });

  it("a stair turns on every storey at once, or on none", () => {
    const stair = (level: number) =>
      box({ id: `s${level}`, name: "Stair", roomType: "stair", left: 2, top: 2, width: 1.2, height: 5, level });
    const out = applyRotations([stair(0), stair(1)], [{ room_name: "Stair", degrees: 90 }], ENV, 2);
    expect(out.applied).toHaveLength(1);
    const held = out.applied[0].degrees;
    expect(out.boxes.map((b) => b.rotation)).toEqual([held, held]);
  });

  it("says what happened, including what would not fit", () => {
    expect(rotationReport({ boxes: [], applied: [{ name: "Office", degrees: 45, wanted: 45 }], refused: [], unknown: [] }))
      .toContain("Turned Office to 45");
    expect(rotationReport({ boxes: [], applied: [{ name: "Office", degrees: 0, wanted: 0 }], refused: [], unknown: [] }))
      .toContain("Straightened Office");
    expect(rotationReport({ boxes: [], applied: [{ name: "Office", degrees: 20, wanted: 45 }], refused: [], unknown: [] }))
      .toContain("as far as 20");
    expect(rotationReport({ boxes: [], applied: [], refused: ["Office"], unknown: [] }))
      .toContain("can't turn at all");
    expect(rotationReport({ boxes: [], applied: [], refused: [], unknown: [] })).toBeNull();
  });
});

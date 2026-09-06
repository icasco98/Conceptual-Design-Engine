import { describe, expect, it } from "vitest";

import { carveWith, displayShapes, releaseCarve, shapeStillUsable, subtractKeepLargest } from "./carve";
import { doorArrows, touchingEdge } from "./doors";
import { footprintRings } from "./footprint";
import { polyArea, rectPolyOf } from "./poly";
import { boxesTrulyIntersect, obbOf, obbsSeparated } from "./rect";
import { shaftsPiercing, stairShafts } from "./shafts";
import { liveBoxes, snapToGrid, snapToNearbyNeighbors } from "./snap";
import type { Box } from "./types";

function box(partial: Partial<Box> & { id: string; left: number; top: number; width: number; height: number }): Box {
  return {
    name: partial.id,
    kind: "room",
    shape: "rect",
    roomType: "bedroom",
    isEntry: false,
    level: 0,
    levelTo: partial.level ?? 0,
    minWidth: 2.7,
    minHeight: 3.0,
    rotation: 0,
    carvedBy: [],
    deleted: false,
    initial: { left: partial.left, top: partial.top, width: partial.width, height: partial.height },
    ...partial,
  };
}

const shapeOf = (live: Box[], id: string) => displayShapes(live).find((s) => s.id === id)!;

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

  it("boxes that only touch along an edge do not overlap", () => {
    const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4 });
    const b = box({ id: "b", left: 4, top: 0, width: 4, height: 4 });
    expect(boxesTrulyIntersect(a, b)).toBe(false);
  });
});

describe("overlap is free; carving is asked for", () => {
  const under = box({ id: "under", left: 0, top: 0, width: 5, height: 5 });
  const over = box({ id: "over", left: 4, top: 4, width: 3, height: 3 });

  it("two overlapping rooms are drawn whole until someone carves", () => {
    const shapes = displayShapes([under, over]);
    expect(shapes.every((s) => !s.carved)).toBe(true);
    expect(polyArea(shapeOf([under, over], "under").page)).toBeCloseTo(25);
  });

  it("carving with the top room cuts the room beneath it and nothing else", () => {
    const far = box({ id: "far", left: 20, top: 20, width: 3, height: 3 });
    const live = carveWith(over, [under, over, far]);
    expect(live.find((b) => b.id === "under")!.carvedBy).toEqual(["over"]);
    expect(live.find((b) => b.id === "far")!.carvedBy).toEqual([]);
    expect(live.find((b) => b.id === "over")!.carvedBy).toEqual([]);
    const s = shapeOf(live, "under");
    expect(s.carved).toBe(true);
    expect(s.flagged).toBe(false);
    expect(polyArea(s.page)).toBeCloseTo(25 - 1);
    // The carver keeps its whole rectangle.
    expect(polyArea(shapeOf(live, "over").page)).toBeCloseTo(9);
  });

  it("the cut follows the carver: move it away and the space comes back", () => {
    const live = carveWith(over, [under, over]);
    const moved = live.map((b) => (b.id === "over" ? { ...b, left: 10 } : b));
    const s = shapeOf(moved, "under");
    expect(s.carved).toBe(false);
    expect(polyArea(s.page)).toBeCloseTo(25);
  });

  it("carving with the other room turns the cut around", () => {
    let live = carveWith(over, [under, over]);
    live = carveWith(live.find((b) => b.id === "under")!, live);
    expect(live.find((b) => b.id === "under")!.carvedBy).toEqual([]);
    expect(live.find((b) => b.id === "over")!.carvedBy).toEqual(["under"]);
    expect(polyArea(shapeOf(live, "over").page)).toBeCloseTo(8);
    expect(polyArea(shapeOf(live, "under").page)).toBeCloseTo(25);
  });

  it("release undoes a carve", () => {
    const live = releaseCarve("over", carveWith(over, [under, over]));
    expect(live.find((b) => b.id === "under")!.carvedBy).toEqual([]);
    expect(shapeOf(live, "under").carved).toBe(false);
  });

  it("a rotated carver cuts a slanted notch", () => {
    const turned = { ...over, rotation: 30 };
    const live = carveWith(turned, [under, turned]);
    const s = shapeOf(live, "under");
    expect(s.carved).toBe(true);
    expect(s.page.length).toBeGreaterThan(4);
    expect(polyArea(s.page)).toBeLessThan(25);
  });
});

describe("the minimum is reported, not enforced", () => {
  it("a room cut below its minimum keeps the cut and is flagged", () => {
    const bath = box({ id: "bath", left: 0, top: 0, width: 1.8, height: 2.4, minWidth: 1.5, minHeight: 1.75 });
    const bed = box({ id: "bed", left: 1.0, top: 0, width: 3.3, height: 3.6 });
    const live = carveWith(bed, [bath, bed]);
    const s = shapeOf(live, "bath");
    expect(s.carved).toBe(true);
    expect(s.flagged).toBe(true);
    // The cut still happened: what is left is the 1.0 m strip.
    expect(polyArea(s.page)).toBeCloseTo(1.0 * 2.4);
  });

  it("a room cut in two keeps its larger piece and is flagged", () => {
    const wide = box({ id: "wide", left: 0, top: 0, width: 10, height: 4, minWidth: 2.7, minHeight: 3 });
    const bar = box({ id: "bar", left: 6, top: -1, width: 1, height: 6, minWidth: 0.9, minHeight: 0.6 });
    const live = carveWith(bar, [wide, bar]);
    const s = shapeOf(live, "wide");
    expect(s.flagged).toBe(true);
    expect(polyArea(s.page)).toBeCloseTo(6 * 4);
  });

  it("a room completely covered is flagged and still drawn so it can be grabbed", () => {
    const small = box({ id: "small", left: 1, top: 1, width: 2, height: 2, minWidth: 1, minHeight: 1 });
    const big = box({ id: "big", left: 0, top: 0, width: 6, height: 6 });
    const live = carveWith(big, [small, big]);
    const s = shapeOf(live, "small");
    expect(s.flagged).toBe(true);
    expect(s.page.length).toBe(4);
  });

  it("shapeStillUsable wants the minimum area and the minimum rectangle", () => {
    const b = box({ id: "b", left: 0, top: 0, width: 4, height: 4, minWidth: 2.7, minHeight: 3 });
    expect(shapeStillUsable(b, rectPolyOf({ left: 0, top: 0, width: 4, height: 4 }))).toBe(true);
    // Same area as 2.7 x 3, but nothing that size fits in it.
    expect(shapeStillUsable(b, rectPolyOf({ left: 0, top: 0, width: 8.1, height: 1 }))).toBe(false);
  });

  it("subtractKeepLargest keeps the biggest piece and reports a split", () => {
    const subject = rectPolyOf({ left: 0, top: 0, width: 10, height: 2 });
    const cutter = rectPolyOf({ left: 3, top: -1, width: 1, height: 4 });
    const { poly, split } = subtractKeepLargest(subject, [cutter]);
    expect(split).toBe(true);
    expect(polyArea(poly)).toBeCloseTo(12);
  });
});

describe("snapping", () => {
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
    const rings = footprintRings(displayShapes([a, b]).map((s) => s.page));
    expect(rings).toHaveLength(1);
    expect(polyArea(rings[0])).toBeCloseTo(32);
  });

  it("the outline of overlapping boxes counts the overlap once", () => {
    const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4 });
    const b = box({ id: "b", left: 3, top: 0, width: 4, height: 4 });
    const rings = footprintRings(displayShapes([a, b]).map((s) => s.page));
    expect(rings).toHaveLength(1);
    expect(polyArea(rings[0])).toBeCloseTo(28);
  });
});

describe("circles", () => {
  it("a circle's outline is the ellipse in its rectangle", () => {
    const c = box({ id: "c", shape: "circle", left: 0, top: 0, width: 4, height: 4 });
    const s = shapeOf([c], "c");
    expect(s.page.length).toBeGreaterThan(8);
    expect(polyArea(s.page)).toBeCloseTo(Math.PI * 4, 0);
  });

  it("a square touching a circle's bounding box but not the circle does not overlap it", () => {
    const c = box({ id: "c", shape: "circle", left: 0, top: 0, width: 4, height: 4 });
    const corner = box({ id: "k", left: 3.5, top: 3.5, width: 2, height: 2 });
    expect(boxesTrulyIntersect(c, corner)).toBe(false);
    expect(boxesTrulyIntersect(c, { ...corner, left: 2.5, top: 2.5 })).toBe(true);
  });

  it("a circle carves a round notch", () => {
    const room = box({ id: "r", left: 0, top: 0, width: 6, height: 6 });
    const c = box({ id: "c", shape: "circle", left: 4, top: 4, width: 4, height: 4 });
    const live = carveWith(c, [room, c]);
    const s = shapeOf(live, "r");
    expect(s.carved).toBe(true);
    expect(s.page.length).toBeGreaterThan(6);
    expect(polyArea(s.page)).toBeLessThan(36);
    expect(polyArea(s.page)).toBeGreaterThan(36 - Math.PI);
  });
});

describe("vertical masses", () => {
  const stair = box({ id: "stair", name: "Stair", roomType: "stair", left: 1.5, top: 2, width: 1.2, height: 5, level: 0, levelTo: 2 });

  it("a zone spanning storeys is live on each of them", () => {
    const bed = box({ id: "bed", left: 8, top: 2, width: 3, height: 4, level: 1 });
    expect(liveBoxes([stair, bed], 0).map((b) => b.id)).toEqual(["stair"]);
    expect(liveBoxes([stair, bed], 1).map((b) => b.id)).toEqual(["stair", "bed"]);
    expect(liveBoxes([stair, bed], 3)).toEqual([]);
  });

  it("a spanning zone is one shaft, not one per storey", () => {
    const shafts = stairShafts([stair, box({ id: "bed", left: 8, top: 2, width: 3, height: 4, level: 1 })]);
    expect(shafts).toHaveLength(1);
    expect(shafts[0].from).toBe(0);
    expect(shafts[0].to).toBe(2);
  });

  it("a shaft pierces the floors above its base, and stands on its own", () => {
    const shafts = stairShafts([stair]);
    expect(shaftsPiercing(shafts, 0)).toHaveLength(0);
    expect(shaftsPiercing(shafts, 1)).toHaveLength(1);
    expect(shaftsPiercing(shafts, 2)).toHaveLength(1);
    expect(shaftsPiercing(shafts, 3)).toHaveLength(0);
  });
});

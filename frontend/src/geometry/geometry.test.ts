import { describe, expect, it } from "vitest";

import { carveWith, displayShapes, releaseCarve, shapeStillUsable, subtractKeepLargest } from "./carve";
import { arrowSegment, nearestWallPoint, suggestArrows } from "./arrows";
import { touchingEdge } from "./doors";
import { footprintRings } from "./footprint";
import { polyArea, polyOfBox, rectPolyOf } from "./poly";
import { boxesTrulyIntersect, obbOf, obbsSeparated } from "./rect";
import { shaftsPiercing, stairShafts } from "./shafts";
import { liveBoxes, snapToGrid, snapToNearbyNeighbors } from "./snap";
import { polyGap, touchDelta, touchSelected } from "./touch";
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
    heightM: 3,
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

describe("door arrows", () => {
  const entry = box({ id: "e", name: "Entry", isEntry: true, roomType: "entry", left: 0, top: 0, width: 2, height: 4 });
  const hall = box({ id: "h", name: "Hall", kind: "corridor", roomType: "hallway", left: 2, top: 0, width: 6, height: 4 });
  const bed = box({ id: "b", name: "Bed", left: 8, top: 0, width: 3.3, height: 4 });

  it("suggests one arrow per zone, walking out from the entry", () => {
    const out = suggestArrows([entry, hall, bed], [], 0);
    expect(out).toHaveLength(2);
    expect(out.map((a) => a.hostId)).toEqual(["e", "h"]);
    expect(out.map((a) => a.targetId)).toEqual(["h", "b"]);
  });

  it("suggests nothing for a zone that already has an arrow into it", () => {
    const existing = suggestArrows([entry, hall, bed], [], 0);
    expect(suggestArrows([entry, hall, bed], existing, 0)).toEqual([]);
  });

  it("hosts a carve's arrow on the carving zone", () => {
    const room = box({ id: "r", left: 0, top: 0, width: 6, height: 6 });
    const cutter = box({ id: "c", left: 4, top: 4, width: 3, height: 3 });
    const live = carveWith(cutter, [room, cutter]);
    const out = suggestArrows(live, [], 0);
    const forRoom = out.find((a) => a.targetId === "r")!;
    expect(forRoom.hostId).toBe("c");
  });

  it("an arrow is perpendicular to its wall and turns with its host", () => {
    const host = box({ id: "h2", left: 0, top: 0, width: 4, height: 4 });
    const arrow = { id: "a", level: 0, hostId: "h2", side: 1, t: 0.5, dir: 1 as const };
    const [tail, head] = arrowSegment(host, arrow);
    // Right wall: the arrow runs along x, through the wall's midpoint.
    expect(tail[1]).toBeCloseTo(2);
    expect(head[1]).toBeCloseTo(2);
    expect(head[0]).toBeGreaterThan(tail[0]);
    // Turn the host 90 degrees and it runs along y instead.
    const [t2, h2] = arrowSegment({ ...host, rotation: 90 }, arrow);
    expect(t2[0]).toBeCloseTo(2);
    expect(h2[1]).toBeGreaterThan(t2[1]);
  });

  it("flipping reverses it through the same point", () => {
    const host = box({ id: "h3", left: 0, top: 0, width: 4, height: 4 });
    const out = arrowSegment(host, { id: "a", level: 0, hostId: "h3", side: 0, t: 0.5, dir: 1 });
    const back = arrowSegment(host, { id: "a", level: 0, hostId: "h3", side: 0, t: 0.5, dir: -1 });
    expect(out[0]).toEqual(back[1]);
    expect(out[1]).toEqual(back[0]);
  });

  it("dragging picks the nearest wall of the host", () => {
    const host = box({ id: "h4", left: 0, top: 0, width: 4, height: 4 });
    expect(nearestWallPoint(host, [2, -0.3]).side).toBe(0);
    expect(nearestWallPoint(host, [4.3, 2]).side).toBe(1);
    expect(nearestWallPoint(host, [2, 4.3]).side).toBe(2);
    expect(nearestWallPoint(host, [-0.3, 2]).side).toBe(3);
    expect(nearestWallPoint(host, [1, -0.3]).t).toBeCloseTo(0.25);
  });
});

describe("make the selected zones touch", () => {
  it("closes a gap under a metre and leaves everything else alone", () => {
    const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4 });
    const b = box({ id: "b", left: 4.6, top: 0, width: 3, height: 3 });
    const out = touchSelected([a, b], ["b"]);
    expect(out.find((x) => x.id === "b")!.left).toBeCloseTo(4);
    expect(out.find((x) => x.id === "a")).toEqual(a);
  });

  it("leaves a gap of a metre or more", () => {
    const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4 });
    const b = box({ id: "b", left: 5.2, top: 0, width: 3, height: 3 });
    expect(touchDelta(b, [a])).toBeNull();
  });

  it("leaves a zone that already touches or overlaps", () => {
    const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4 });
    expect(touchDelta(box({ id: "b", left: 4, top: 0, width: 3, height: 3 }), [a])).toBeNull();
    expect(touchDelta(box({ id: "c", left: 3, top: 0, width: 3, height: 3 }), [a])).toBeNull();
  });

  it("two zones turned the same way meet flush along their walls", () => {
    // Both at 30 degrees. A box's left/top is its UNROTATED corner and it
    // turns about its own centre, so b is placed by its centre: 4 m (one
    // full width) plus the gap, along a's own x axis.
    const rad = (30 * Math.PI) / 180;
    const gap = 0.6;
    const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4, rotation: 30 });
    const reach = 4 + gap;
    const b = box({
      id: "b",
      left: 2 + reach * Math.cos(rad) - 2,
      top: 2 + reach * Math.sin(rad) - 2,
      width: 4,
      height: 4,
      rotation: 30,
    });
    const out = touchSelected([a, b], ["b"]);
    const moved = out.find((x) => x.id === "b")!;
    expect(boxesTrulyIntersect(moved, a)).toBe(false);
    expect(polyGap(polyOfBox(moved), polyOfBox(a)).d).toBeCloseTo(0, 3);
  });

  it("a circle meets its neighbour tangentially", () => {
    const wall = box({ id: "w", left: 0, top: 0, width: 6, height: 1 });
    const c = box({ id: "c", shape: "circle", left: 2, top: 1.5, width: 2, height: 2 });
    const out = touchSelected([wall, c], ["c"]);
    const moved = out.find((x) => x.id === "c")!;
    expect(moved.top).toBeCloseTo(1, 2);
  });

  it("two selected zones close on one another", () => {
    const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4 });
    const b = box({ id: "b", left: 4.5, top: 0, width: 3, height: 3 });
    const out = touchSelected([a, b], ["a", "b"]);
    expect(polyGap(polyOfBox(out[0]), polyOfBox(out[1])).d).toBeCloseTo(0, 3);
  });
});

describe("vertical masses", () => {
  const stair = box({ id: "stair", name: "Stair", roomType: "stair", left: 1.5, top: 2, width: 1.2, height: 5, level: 0, levelTo: 2, heightM: 9 });

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

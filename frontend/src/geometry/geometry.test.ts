import { describe, expect, it } from "vitest";

import { carveWith, displayShapes, releaseCarve, shapeStillUsable, subtractKeepLargest } from "./carve";
import { arrowSegment, nearestWallPoint, suggestArrows } from "./arrows";
import { touchingEdge } from "./doors";
import { footprintRings } from "./footprint";
import { clampDrawnRect, clampGroup, isOutsidePlot, limitGrowth, limitPointGrowth, settleInPlot, shiftInside } from "./plot";
import { anchorPoint, polyArea, polyOfBox, rectPolyOf, resizedFromAnchor } from "./poly";
import { boxesTrulyIntersect, obbOf, obbsSeparated } from "./rect";
import { isOpenToBelow, liveBoxes, nearestNeighborPoint, snapToGrid, snapToNearbyNeighbors, wallSnapAdjust } from "./snap";
import { polyGap, touchDelta, touchSelected } from "./touch";
import type { Box, Plot, Point, Poly } from "./types";

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
    priority: 2,
    carvedBy: [],
    deleted: false,
    initial: { left: partial.left, top: partial.top, width: partial.width, height: partial.height },
    ...partial,
  };
}

const shapeOf = (live: Box[], id: string, autoCarve = false) =>
  displayShapes(live, autoCarve).find((s) => s.id === id)!;

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

describe("automatic carving, by priority", () => {
  const hall = box({ id: "hall", left: 0, top: 0, width: 8, height: 2, priority: 1, minWidth: 1.2, minHeight: 1.2 });
  const room = box({ id: "room", left: 3, top: 1, width: 5, height: 5, priority: 2 });

  it("does nothing until it is switched on", () => {
    expect(shapeOf([hall, room], "room").carved).toBe(false);
    expect(polyArea(shapeOf([hall, room], "room").page)).toBeCloseTo(25);
  });

  it("carves the lower priority where they overlap, and only that one", () => {
    expect(shapeOf([hall, room], "room", true).carved).toBe(true);
    expect(polyArea(shapeOf([hall, room], "room", true).page)).toBeCloseTo(25 - 5);
    // The corridor keeps everything: nothing outranks it.
    expect(shapeOf([hall, room], "hall", true).carved).toBe(false);
  });

  it("leaves equal priorities alone rather than guessing", () => {
    const tie = { ...room, priority: hall.priority };
    expect(shapeOf([hall, tie], tie.id, true).carved).toBe(false);
    expect(shapeOf([hall, tie], hall.id, true).carved).toBe(false);
  });

  it("is computed, not stored: switching it off restores the zone", () => {
    const live = [hall, room];
    expect(shapeOf(live, "room", true).carved).toBe(true);
    expect(shapeOf(live, "room", false).carved).toBe(false);
    expect(live.find((b) => b.id === "room")!.carvedBy).toEqual([]);
  });

  it("a cut asked for by hand stands whether it is on or off", () => {
    const asked = carveWith(room, [hall, room]);
    expect(shapeOf(asked, "hall", false).carved).toBe(true);
    expect(shapeOf(asked, "hall", true).carved).toBe(true);
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

describe("a tall zone seen from the storey above", () => {
  const tall = box({ id: "t", name: "Living", left: 0, top: 0, width: 5, height: 5, level: 0, levelTo: 1, heightM: 5 });
  const stair = box({ id: "s", name: "Stair", roomType: "stair", left: 8, top: 0, width: 1.2, height: 4, level: 0, levelTo: 1, heightM: 6 });

  it("is a void on the storeys above its own floor, but not on its own", () => {
    expect(isOpenToBelow(tall, 0)).toBe(false);
    expect(isOpenToBelow(tall, 1)).toBe(true);
    // Not on a storey it never reaches.
    expect(isOpenToBelow(tall, 2)).toBe(false);
  });

  it("never applies to a stair, which is a hole you do walk through", () => {
    expect(isOpenToBelow(stair, 1)).toBe(false);
  });

  it("takes no part in the door-arrow walk on that storey", () => {
    const entry = box({ id: "e", name: "Landing", isEntry: true, roomType: "entry", left: 5, top: 0, width: 2, height: 5, level: 1 });
    // On the ground floor the tall zone is an ordinary room and gets a door.
    const ground = suggestArrows([{ ...entry, level: 0, levelTo: 0 }, tall], [], 0);
    expect(ground.map((a) => a.targetId)).toEqual(["t"]);
    // Upstairs it is a void: no arrow to it, and none hosted on it.
    const upstairs = suggestArrows([entry, tall], [], 1);
    expect(upstairs).toEqual([]);
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

  it("a zone that starts below a storey pierces its floor plate", () => {
    // What the 3D cuts a hole for: anything whose base is under the plate
    // and which is still live on that storey.
    const pierces = (lv: number) => liveBoxes([stair], lv).filter((b) => b.level < lv).length;
    expect(pierces(0)).toBe(0);
    expect(pierces(1)).toBe(1);
    expect(pierces(2)).toBe(1);
    expect(pierces(3)).toBe(0);
  });
});

describe("the plot as a boundary", () => {
  /** A 20 x 12 m site at the sheet's origin, binding. */
  const plot: Plot = { on: true, left: 0, top: 0, width: 20, depth: 12 };
  const off: Plot = { ...plot, on: false };

  it("leaves a zone alone while the boundary is switched off", () => {
    const b = box({ id: "a", left: 30, top: 30, width: 4, height: 3 });
    expect(isOutsidePlot(b, off)).toBe(false);
    expect(clampGroup([b], ["a"], off)).toEqual([b]);
  });

  it("stops a zone at the wall it is dragged into", () => {
    // Pushed 4 m past the right-hand edge: it comes back exactly 4 m.
    const b = box({ id: "a", left: 20, top: 4, width: 4, height: 3 });
    const [moved] = clampGroup([b], ["a"], plot);
    expect(moved.left).toBeCloseTo(16, 6);
    // ...and not at all on the axis it never crossed.
    expect(moved.top).toBeCloseTo(4, 6);
  });

  it("clamps a selection as one rigid body, so it does not deform", () => {
    // Two zones 1 m apart, dragged together past the bottom edge. Both
    // must move by the same amount or the gap between them changes.
    const a = box({ id: "a", left: 2, top: 10, width: 3, height: 3 });
    const b = box({ id: "b", left: 6, top: 10, width: 3, height: 5 });
    const out = clampGroup([a, b], ["a", "b"], plot);
    const da = out[0].top - a.top;
    const db = out[1].top - b.top;
    expect(da).toBeCloseTo(db, 6);
    // The lower of the two ends flush against the boundary.
    expect(out[1].top + out[1].height).toBeCloseTo(12, 6);
  });

  it("holds a turned zone by its corners, not by its rectangle", () => {
    // A 4 x 4 square at 45 degrees reaches 2.83 m from its centre, not
    // 2 m. Sat against the left edge upright it fits; turned it does not.
    const upright = box({ id: "a", left: 0, top: 4, width: 4, height: 4 });
    expect(isOutsidePlot(upright, plot)).toBe(false);
    const turned = { ...upright, rotation: 45 };
    expect(isOutsidePlot(turned, plot)).toBe(true);
    const [slid] = clampGroup([turned], ["a"], plot);
    expect(isOutsidePlot(slid, plot)).toBe(false);
    // It slid in rather than being refused the rotation.
    expect(slid.rotation).toBe(45);
    expect(slid.left).toBeGreaterThan(upright.left);
  });

  it("does not fight a zone too big for the plot: it flags it instead", () => {
    const huge = box({ id: "a", left: -5, top: 2, width: 40, height: 4 });
    expect(isOutsidePlot(huge, plot)).toBe(true);
    // Nothing to be done on x -- it cannot fit -- so x is left alone.
    const [same] = clampGroup([huge], ["a"], plot);
    expect(same.left).toBeCloseTo(-5, 6);
  });

  it("stops a resize at the wall without moving the anchored corner", () => {
    const from = box({ id: "a", left: 16, top: 2, width: 3, height: 3 });
    // Dragged out to 9 m wide, which would take it 5 m past the edge.
    const to = { ...from, width: 9 };
    const held = limitGrowth(from, to, plot, "inside");
    expect(held.left).toBeCloseTo(16, 6);
    // 4 m to the millimetre: the bisection is allowed to settle within
    // plot.ts's own tolerance of the wall, and no further.
    expect(held.width).toBeCloseTo(4, 2);
    expect(isOutsidePlot(held, plot)).toBe(false);
  });

  it("lets a resize that stays inside through untouched", () => {
    const from = box({ id: "a", left: 2, top: 2, width: 3, height: 3 });
    const to = { ...from, width: 6 };
    expect(limitGrowth(from, to, plot, "inside")).toEqual(to);
  });

  it("leaves a zone that was already outside to be edited freely", () => {
    // Rule 3: it was not put there by this edit, so this edit does not
    // take it over. Moving it in is the person's to do.
    const from = box({ id: "a", left: 40, top: 40, width: 3, height: 3 });
    const to = { ...from, width: 9 };
    expect(limitGrowth(from, to, plot, "inside")).toEqual(to);
    expect(settleInPlot(from, to, plot)).toEqual(to);
  });

  it("caps a size typed into the schedule and slides the zone in", () => {
    // The schedule must obey the same wall as the canvas, or it is a way
    // around it: 40 m of width in a 20 m plot caps at 20.
    const from = box({ id: "a", left: 6, top: 2, width: 3, height: 3 });
    const settled = settleInPlot(from, { ...from, width: 40 }, plot);
    expect(settled.width).toBeCloseTo(20, 2);
    expect(isOutsidePlot(settled, plot)).toBe(false);
  });

  it("cuts a zone being drawn back to the boundary", () => {
    const r = clampDrawnRect({ left: 17, top: 10, width: 8, height: 6 }, plot);
    expect(r).toEqual({ left: 17, top: 10, width: 3, height: 2 });
  });

  it("takes the offset of a plot that does not start at the origin", () => {
    const offset: Plot = { on: true, left: 4, top: 3, width: 10, depth: 8 };
    const b = box({ id: "a", left: 0, top: 0, width: 2, height: 2 });
    const [moved] = clampGroup([b], ["a"], offset);
    expect(moved.left).toBeCloseTo(4, 6);
    expect(moved.top).toBeCloseTo(3, 6);
  });

  it("reports no shift for a zone already inside", () => {
    expect(shiftInside(polyOfBox(box({ id: "a", left: 5, top: 5, width: 2, height: 2 })), plot)).toEqual([0, 0]);
  });
});

describe("resizing a rotated zone holds the corner you are not dragging still", () => {
  it("keeps the anchor corner fixed on the page when the box is unrotated", () => {
    const b = box({ id: "a", left: 0, top: 0, width: 4, height: 2 });
    const anchor = anchorPoint(b, -1, -1); // nw, opposite an se drag
    expect(anchor).toEqual([0, 0]);
    const resized = resizedFromAnchor(b, anchor, -1, -1, 6, 5);
    expect(resized.left).toBeCloseTo(0, 6);
    expect(resized.top).toBeCloseTo(0, 6);
    expect(resized.width).toBe(6);
    expect(resized.height).toBe(5);
  });

  it("keeps the far corner fixed on the page for a 90-degree turned box", () => {
    // left=0,top=0,4x2, rotated 90deg: cx=2,cy=1, cos=0,sin=1, so nw's
    // page position works out to (3, -1) by hand.
    const b = box({ id: "a", left: 0, top: 0, width: 4, height: 2, rotation: 90 });
    const anchor = anchorPoint(b, -1, -1); // dragging se, nw is the anchor
    expect(anchor[0]).toBeCloseTo(3, 6);
    expect(anchor[1]).toBeCloseTo(-1, 6);
    const resized = resizedFromAnchor(b, anchor, -1, -1, 6, 2);
    // The anchor corner must still be exactly there after the resize.
    const nwOnPage = anchorPoint(resized, -1, -1);
    expect(nwOnPage[0]).toBeCloseTo(3, 6);
    expect(nwOnPage[1]).toBeCloseTo(-1, 6);
  });

  it("keeps the far corner fixed for an arbitrary rotation, on every corner", () => {
    const base = box({ id: "a", left: 1, top: 2, width: 5, height: 3, rotation: 37 });
    for (const [sx, sy] of [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ] as const) {
      const anchor = anchorPoint(base, sx, sy);
      const resized = resizedFromAnchor(base, anchor, sx, sy, 8, 6);
      const stillThere = anchorPoint(resized, sx, sy);
      expect(stillThere[0]).toBeCloseTo(anchor[0], 6);
      expect(stillThere[1]).toBeCloseTo(anchor[1], 6);
    }
  });

  it("keeps the opposite wall's midpoint fixed for an edge drag on a rotated zone", () => {
    const base = box({ id: "a", left: 0, top: 0, width: 4, height: 2, rotation: 30 });
    // Dragging the east wall: the west wall's midpoint (sx=-1, sy=0) anchors.
    const anchor = anchorPoint(base, -1, 0);
    const resized = resizedFromAnchor(base, anchor, -1, 0, 9, 2);
    const stillThere = anchorPoint(resized, -1, 0);
    expect(stillThere[0]).toBeCloseTo(anchor[0], 6);
    expect(stillThere[1]).toBeCloseTo(anchor[1], 6);
    expect(resized.width).toBe(9);
    expect(resized.height).toBe(2);
  });
});

describe("snapping a polygon corner or wall to a neighbour", () => {
  const neighbor: Poly = [
    [5, 0],
    [8, 0],
    [8, 3],
    [5, 3],
  ];

  it("snaps a dragged point onto the neighbour's corner within reach", () => {
    expect(nearestNeighborPoint([5.1, 0.1], [neighbor])).toEqual([5, 0]);
  });

  it("snaps a dragged point onto the neighbour's wall, not its corner, mid-wall", () => {
    const snapped = nearestNeighborPoint([5.1, 1.5], [neighbor]);
    expect(snapped![0]).toBeCloseTo(5, 6);
    expect(snapped![1]).toBeCloseTo(1.5, 6);
  });

  it("does not snap once the neighbour is out of reach", () => {
    expect(nearestNeighborPoint([5.5, 1.5], [neighbor])).toBeNull();
  });

  it("pulls a wall flush against a parallel neighbour wall just short of it", () => {
    // Our wall runs vertically at x=4.9, pushed toward the neighbour's
    // wall at x=5: wallSnapAdjust should report the extra 0.1 needed.
    const extra = wallSnapAdjust([4.9, 0], [4.9, 3], [1, 0], [neighbor]);
    expect(extra).toBeCloseTo(0.1, 6);
  });

  it("ignores a neighbour wall that isn't parallel", () => {
    // A diagonal wall right up against the neighbour's corner: neither
    // of the neighbour's own walls (horizontal, vertical) runs the same
    // way as this one, so proximity alone must not be enough to snap.
    const extra = wallSnapAdjust([4, 0], [4.3, 0.4], [0.8, -0.6], [neighbor]);
    expect(extra).toBe(0);
  });
});

describe("door arrows on a polygon zone read its own walls, not its bounding box", () => {
  // An L: (0,0)-(6,0)-(6,2)-(3,2)-(3,4)-(0,4), missing the bottom-right
  // quarter of its 6x4 bounding box -- clockwise, as rectPolyOf winds.
  const lShapeCW: Box = box({
    id: "l",
    left: 0,
    top: 0,
    width: 6,
    height: 4,
    shape: "polygon",
    points: [
      [0, 0],
      [1, 0],
      [1, 0.5],
      [0.5, 0.5],
      [0.5, 1],
      [0, 1],
    ],
  });

  it("finds the real nearest wall for a point over the missing notch, not a bounding-box side", () => {
    // (5, 3) sits inside the bounding box but outside the L, in the
    // notch. Its true nearest wall is edge 2, the one facing the notch
    // (from (6,2) to (3,2)), one metre away -- not either bounding-box
    // side that would tie for "nearest" at the same distance.
    const { side, t } = nearestWallPoint(lShapeCW, [5, 3]);
    expect(side).toBe(2);
    expect(t).toBeCloseTo(1 / 3, 6);
  });

  it("puts the arrow's midpoint exactly on that wall, not off in space", () => {
    const arrow = { id: "a", level: 0, hostId: "l", side: 2, t: 1 / 3, dir: 1 as const };
    const [tail, head] = arrowSegment(lShapeCW, arrow);
    const mid: [number, number] = [(tail[0] + head[0]) / 2, (tail[1] + head[1]) / 2];
    // Edge 2 runs from (6,2) to (3,2) at t=1/3: (6,2) + 1/3 * (3-6, 0).
    expect(mid[0]).toBeCloseTo(5, 6);
    expect(mid[1]).toBeCloseTo(2, 6);
  });

  /** Standard ray-cast point-in-polygon: true for a point inside `poly`. */
  function inside(p: readonly [number, number], poly: readonly (readonly [number, number])[]): boolean {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  }

  it("points the arrow outward on every wall regardless of which way the polygon winds", () => {
    // The same L, wound the other way (its points listed in reverse) --
    // the L is concave, so this also has to hold at the notch's own
    // inner corner, not just its convex corners.
    const lShapeCCW: Box = box({ ...lShapeCW, id: "l2", points: [...lShapeCW.points!].reverse() });
    for (const host of [lShapeCW, lShapeCCW]) {
      const abs = host.points!.map(([fx, fy]): [number, number] => [host.left + fx * host.width, host.top + fy * host.height]);
      for (let side = 0; side < abs.length; side++) {
        const arrow = { id: "a", level: 0, hostId: host.id, side, t: 0.5, dir: 1 as const };
        const [tail, head] = arrowSegment(host, arrow);
        expect(inside(tail, abs)).toBe(true);
        expect(inside(head, abs)).toBe(false);
      }
    }
  });
});

describe("a polygon's own corners and walls are held inside the plot too", () => {
  const plot: Plot = { on: true, left: 0, top: 0, width: 8, depth: 8 };
  // A plain 4x4 square, drawn as a polygon, inside an 8x8 plot: corners
  // at (2,2), (6,2), (6,6), (2,6).
  const square: Box = box({
    id: "p",
    left: 2,
    top: 2,
    width: 4,
    height: 4,
    shape: "polygon",
    points: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  });

  it("holds a dragged corner at the boundary instead of letting it pass through", () => {
    // Corner 1, (6,2), dragged 8m east to (14,2) -- well past the plot's
    // right edge at x=8.
    const dragged: Point[] = [square.points![0], [3, 0], square.points![2], square.points![3]];
    const held = limitPointGrowth(square, dragged, plot);
    const abs = held.points!.map(([fx, fy]): [number, number] => [held.left + fx * held.width, held.top + fy * held.height]);
    expect(abs[1][0]).toBeLessThanOrEqual(8 + 1e-3);
    expect(abs[1][0]).toBeGreaterThan(7.9);
    expect(abs[1][1]).toBeCloseTo(2, 6);
  });

  it("leaves every corner not being dragged exactly where it was", () => {
    const dragged: Point[] = [square.points![0], [3, 0], square.points![2], square.points![3]];
    const held = limitPointGrowth(square, dragged, plot);
    const abs = held.points!.map(([fx, fy]): [number, number] => [held.left + fx * held.width, held.top + fy * held.height]);
    expect(abs[0]).toEqual([2, 2]);
    expect(abs[2]).toEqual([6, 6]);
    expect(abs[3]).toEqual([2, 6]);
  });

  it("holds a dragged wall's two corners at the boundary together", () => {
    // The east wall (corners 1 and 2) pushed 8m east.
    const dragged: Point[] = [square.points![0], [3, 0], [3, 1], square.points![3]];
    const held = limitPointGrowth(square, dragged, plot);
    const abs = held.points!.map(([fx, fy]): [number, number] => [held.left + fx * held.width, held.top + fy * held.height]);
    expect(abs[1][0]).toBeCloseTo(abs[2][0], 6);
    expect(abs[1][0]).toBeLessThanOrEqual(8 + 1e-3);
    expect(abs[1][0]).toBeGreaterThan(7.9);
    expect(abs[0]).toEqual([2, 2]);
    expect(abs[3]).toEqual([2, 6]);
  });

  it("passes a drag straight through when it stays inside the plot", () => {
    const dragged: Point[] = [square.points![0], [1.25, 0], square.points![2], square.points![3]];
    const held = limitPointGrowth(square, dragged, plot);
    expect(held.points).toEqual(dragged);
  });
});

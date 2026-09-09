import { describe, expect, it } from "vitest";

import { carveWith, displayShapes, releaseCarve, shapeStillUsable, subtractKeepLargest } from "./carve";
import { arrowSegment, liveWallPoint, nearestWallPoint, suggestArrows } from "./arrows";
import { actorRoute, arrowIsLive, buildCirculationGraph, liveArrowIds, minHopCount, outOfBounds, reachabilityProblems, routeLength, sharedSegments, syncFrozenArrowPoints } from "./circulation";
import { buildTouchGraph, touchingEdges } from "./doors";
import { footprintRings } from "./footprint";
import { clampDrawnRect, clampGroup, isOutsidePlot, limitGrowth, limitPointGrowth, settleInPlot, shiftInside } from "./plot";
import { anchorPoint, polyArea, polyOfBox, rectPolyOf, resizedFromAnchor } from "./poly";
import { boxesTrulyIntersect, centerOf, obbOf, obbsSeparated, rectOf } from "./rect";
import { checkAdjacency, collectFindings, compareScores, scoreCandidate, stairConnectionProblems, tierViolations } from "./relationships";
import { isOpenToBelow, liveBoxes, nearestNeighborPoint, snapToGrid, snapToNearbyNeighbors, wallSnapAdjust } from "./snap";
import { touchDelta, touchSelected, polyGap } from "./touch";
import type { Arrow, Box, Plot, Point, Poly } from "./types";
import { SAMPLE_STOREYS, sampleArrows, sampleBoxes } from "../sample";
import { auxiliaryOf, circulationOf, isServiceOf, passableOf, tierOf, zoneOf } from "../rooms";

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
    const touches = touchingEdges(rectPolyOf({ left: 0, top: 0, width: 4, height: 4 }), rectPolyOf({ left: 4, top: 1, width: 3, height: 3 }), 0.04);
    expect(touches).toHaveLength(1);
    expect(touches[0].p1).toEqual([4, 1]);
    expect(touches[0].p2).toEqual([4, 4]);
    expect(touchingEdges(rectPolyOf({ left: 0, top: 0, width: 4, height: 4 }), rectPolyOf({ left: 4, top: 4, width: 3, height: 3 }), 0.04)).toHaveLength(0);
  });

  it("finds a shared wall between two rotated zones at whatever angle they actually touch", () => {
    // Two 2x2 squares, each turned 45 degrees about its own centre: p
    // sits at the origin, q at (root2, root2), placed so one of p's
    // turned edges lies exactly along one of q's -- neither box, nor the
    // wall between them, is axis-aligned.
    const SQ2 = Math.SQRT2;
    const p = box({ id: "p", left: -1, top: -1, width: 2, height: 2, rotation: 45 });
    const q = box({ id: "q", left: SQ2 - 1, top: SQ2 - 1, width: 2, height: 2, rotation: 45 });
    const touches = touchingEdges(polyOfBox(p), polyOfBox(q), 0.01);
    expect(touches).toHaveLength(1);
    const runLen = Math.hypot(touches[0].p2[0] - touches[0].p1[0], touches[0].p2[1] - touches[0].p1[1]);
    expect(runLen).toBeCloseTo(2, 4);
  });

  it("finds the wall a hand-drawn polygon actually shares, not just its bounding box", () => {
    const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4 });
    // A right triangle whose vertical edge (from its top-left corner
    // down to its bottom-left) exactly matches a's right wall -- its
    // hypotenuse and top edge share nothing with a at all.
    const tri = box({ id: "tri", shape: "polygon", left: 4, top: 0, width: 3, height: 4, points: [[0, 0], [1, 0], [0, 1]] });
    const touches = touchingEdges(polyOfBox(a), polyOfBox(tri), 0.04);
    expect(touches).toHaveLength(1);
    expect(touches[0].p1).toEqual([4, 0]);
    expect(touches[0].p2).toEqual([4, 4]);
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
    const out = suggestArrows([entry, hall, bed], [], 0, false);
    expect(out).toHaveLength(2);
    expect(out.map((a) => a.hostId)).toEqual(["e", "h"]);
    expect(out.map((a) => a.targetId)).toEqual(["h", "b"]);
  });

  it("suggests nothing for a zone that already has an arrow into it", () => {
    const existing = suggestArrows([entry, hall, bed], [], 0, false);
    expect(suggestArrows([entry, hall, bed], existing, 0, false)).toEqual([]);
  });

  it("hosts a carve's arrow on the carving zone, placed on the real cut boundary", () => {
    const room = box({ id: "r", left: 0, top: 0, width: 6, height: 6 });
    const cutter = box({ id: "c", left: 4, top: 4, width: 3, height: 3 });
    const live = carveWith(cutter, [room, cutter]);
    const out = suggestArrows(live, [], 0, false);
    const forRoom = out.find((a) => a.targetId === "r")!;
    expect(forRoom.hostId).toBe("c");
    // Not just hosted on the carver, but actually on the line the two
    // now share: circulation, built from nothing but this one arrow,
    // finds a genuine route between them through it.
    const graph = buildCirculationGraph(live, 1, out, false);
    const { segments, broken } = actorRoute(graph, live, ["c", "r"]);
    expect(broken).toHaveLength(0);
    expect(segments).toHaveLength(1);
  });

  it("walks out across a rotated zone's own turned wall, not just a plain rectangle's", () => {
    // Hall shares its right wall with a room turned 90 degrees -- still
    // axis-aligned on the page (a quarter turn swaps width and height
    // without tilting it), chosen so that swap lands its left wall
    // exactly on hall's right wall, x = 8, for hall's full height.
    const turnedBed = box({ id: "b", name: "Bed", left: 7.65, top: 0.35, width: 4, height: 3.3, rotation: 90 });
    const out = suggestArrows([entry, hall, turnedBed], [], 0, false);
    expect(out.map((a) => a.targetId)).toContain("b");
  });

  it("connects a carved-into zone to its carver through the walk too, when only automatic carving is in effect", () => {
    // No explicit `carvedBy` here -- carving is automatic, priority-only,
    // so the explicit carve loop above (which only ever looks at
    // `carvedBy`) never fires for this pair. Any connection between them
    // can only come from the general walk, fed the auto-carved outline.
    const carver = box({ id: "c", name: "Cutter", isEntry: true, priority: 1, left: 4, top: 4, width: 3, height: 3 });
    const room = box({ id: "r", name: "Room", priority: 2, left: 0, top: 0, width: 6, height: 6 });
    const out = suggestArrows([carver, room], [], 0, true);
    expect(out.some((a) => a.targetId === "r")).toBe(true);
  });

  it("hosts a carve-boundary arrow on the carver even when the walk reaches the pair from the victim's side first", () => {
    // The entry -- so the walk's own starting point -- is the victim
    // here, the opposite direction from the test just above. The door
    // this finds must still be hosted on the carver: the cut boundary
    // is congruent to the carver's own edge, not the victim's, whatever
    // direction the walk happened to reach it from.
    const room = box({ id: "r", name: "Room", isEntry: true, priority: 2, left: 0, top: 0, width: 6, height: 6 });
    const carver = box({ id: "c", name: "Cutter", priority: 1, left: 4, top: 4, width: 3, height: 3 });
    const out = suggestArrows([room, carver], [], 0, true);
    expect(out).toHaveLength(1);
    expect(out[0].hostId).toBe("c");
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

describe("liveWallPoint: a click or drag resolves to whichever real wall it actually lands on", () => {
  it("resolves onto the host's own wall for an ordinary click near it, untouched by any carve", () => {
    const room = box({ id: "r", left: 0, top: 0, width: 6, height: 6 });
    const live = [room];
    const polyById = new Map(live.map((b) => [b.id, polyOfBox(b)]));
    const resolved = liveWallPoint(room, live, polyById, [6.2, 3]);
    expect(resolved?.host.id).toBe("r");
    expect(resolved?.side).toBe(1);
    expect(resolved?.t).toBeCloseTo(0.5, 6);
  });

  it("resolves onto the carver once a carve has taken the clicked stretch of the host's own wall", () => {
    const room = box({ id: "r", left: 0, top: 0, width: 6, height: 6, carvedBy: ["c"] });
    const carver = box({ id: "c", left: 4, top: 4, width: 3, height: 3 });
    const live = [room, carver];
    const polyById = new Map(displayShapes(live, false).map((s) => [s.id, s.page]));
    // Exactly on the notch's own left edge -- the carver's, not room's.
    const resolved = liveWallPoint(room, live, polyById, [4, 5]);
    expect(resolved?.host.id).toBe("c");
  });

  it("still resolves onto the host's own wall elsewhere on it, once a carve has only taken a different stretch", () => {
    const room = box({ id: "r", left: 0, top: 0, width: 6, height: 6, carvedBy: ["c"] });
    const carver = box({ id: "c", left: 4, top: 4, width: 3, height: 3 });
    const live = [room, carver];
    const polyById = new Map(displayShapes(live, false).map((s) => [s.id, s.page]));
    // room's left wall is nowhere near the carve.
    const resolved = liveWallPoint(room, live, polyById, [-0.2, 3]);
    expect(resolved?.host.id).toBe("r");
  });

  it("returns null when the box has no outline at all right now", () => {
    const room = box({ id: "r", left: 0, top: 0, width: 6, height: 6 });
    const polyById = new Map<string, Poly>();
    expect(liveWallPoint(room, [room], polyById, [6, 3])).toBeNull();
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
    const ground = suggestArrows([{ ...entry, level: 0, levelTo: 0 }, tall], [], 0, false);
    expect(ground.map((a) => a.targetId)).toEqual(["t"]);
    // Upstairs it is a void: no arrow to it, and none hosted on it.
    const upstairs = suggestArrows([entry, tall], [], 1, false);
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

describe("circulation: a route is the shortest walk of real doors", () => {
  // A: 0,0 4x4 -- B: 4,0 3x4 -- C: 7,0 4x4, all touching in a straight line.
  const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4 });
  const b = box({ id: "b", left: 4, top: 0, width: 3, height: 4 });
  const c = box({ id: "c", left: 7, top: 0, width: 4, height: 4 });
  const isolated = box({ id: "isolated", left: 20, top: 20, width: 2, height: 2 });
  // Doors placed at each wall's own midpoint -- so a route through them
  // lands on the same points the old geometric-midpoint fallback used
  // to produce. The fallback is gone; a real door placed exactly there
  // should still look the same.
  const doorAB: Arrow = { id: "dAB", level: 0, hostId: "a", kind: "interior", side: 1, t: 0.5, dir: 1 };
  const doorBC: Arrow = { id: "dBC", level: 0, hostId: "b", kind: "interior", side: 1, t: 0.5, dir: 1 };
  const DOORS = [doorAB, doorBC];

  const polyById = (boxes: Box[]) => new Map(boxes.map((bx) => [bx.id, polyOfBox(bx)]));

  it("finds no edge between zones that do not touch", () => {
    const graph = buildCirculationGraph([a, isolated], 1, [], false);
    expect(graph.get("a") ?? []).toHaveLength(0);
  });

  it("buildTouchGraph is the one shared primitive: both directions, one entry per touching pair", () => {
    const touchGraph = buildTouchGraph(polyById([a, b, c, isolated]), 0.04);
    expect(touchGraph.get("a")?.map((e) => e.to)).toEqual(["b"]);
    expect(touchGraph.get("b")?.map((e) => e.to).sort()).toEqual(["a", "c"]);
    expect(touchGraph.get("isolated") ?? []).toHaveLength(0);
  });

  it("a wall two zones share is not, on its own, a route -- no door placed on it means no edge at all", () => {
    const graph = buildCirculationGraph([a, b, c], 1, [], false);
    expect(graph.get("a") ?? []).toHaveLength(0);
    const { segments, broken } = actorRoute(graph, [a, b, c], ["a", "c"]);
    expect(segments).toHaveLength(0);
    expect(broken).toEqual([{ fromId: "a", toId: "c" }]);
  });

  it("routes through a placed door, not straight through the room between", () => {
    const graph = buildCirculationGraph([a, b, c], 1, DOORS, false);
    const { segments, broken } = actorRoute(graph, [a, b, c], ["a", "c"]);
    expect(broken).toHaveLength(0);
    expect(segments).toHaveLength(1);
    const pts = segments[0].pts;
    // centre a, door a|b, centre b, door b|c, centre c.
    expect(pts).toHaveLength(5);
    expect(pts[0]).toEqual(centerOf(rectOf(a)));
    expect(pts[1]).toEqual([4, 2]);
    expect(pts[2]).toEqual(centerOf(rectOf(b)));
    expect(pts[3]).toEqual([7, 2]);
    expect(pts[4]).toEqual(centerOf(rectOf(c)));
    // Centre a to the a|b door (2m), on to b's centre (1.5m), on to the
    // b|c door (1.5m), on to c's centre (2m): the doors sit exactly on
    // the straight line between centres here, so this also equals the
    // distance straight from centre to centre.
    expect(routeLength(segments)).toBeCloseTo(7, 6);
  });

  it("skips a waypoint that no longer exists, rather than losing the rest of the route", () => {
    const graph = buildCirculationGraph([a, b, c], 1, DOORS, false);
    const { segments } = actorRoute(graph, [a, b, c], ["a", "gone", "c"]);
    expect(routeLength(segments)).toBeCloseTo(7, 6);
  });

  it("includes a rotated zone: its own turned wall, not a plain rectangle's, decides what it touches", () => {
    // Turned 90 degrees, "turned" stays axis-aligned on the page (its
    // width and height merely swap around the same centre) -- chosen so
    // that swap lands its left wall exactly on a's right wall, x = 4,
    // for the full height of both. b is dropped, so there is exactly
    // one shared wall in this arrangement to find, and it belongs to a
    // rotated zone.
    const turned = box({ id: "turned", left: 3.5, top: 0.5, width: 4, height: 3, rotation: 90 });
    const door: Arrow = { id: "dT", level: 0, hostId: "a", kind: "interior", side: 1, t: 0.5, dir: 1 };
    const graph = buildCirculationGraph([a, turned], 1, [door], false);
    const { segments, broken } = actorRoute(graph, [a, turned], ["a", "turned"]);
    expect(broken).toHaveLength(0);
    expect(segments).toHaveLength(1);
  });

  it("a carved-into zone routes to its carver: the cut boundary is a real shared wall too", () => {
    // The cutter overlaps room's corner and sticks out past it; the
    // notch this leaves in room and the cutter's own outline now share
    // exactly the overlap's edges -- a real wall, with no special-case
    // carve handling in the circulation graph at all, just the same
    // "do these outlines share a wall" question asked of any pair.
    const room = box({ id: "room", left: 0, top: 0, width: 6, height: 6, carvedBy: ["cutter"] });
    const cutter = box({ id: "cutter", left: 4, top: 4, width: 3, height: 3 });
    const door: Arrow = { id: "dCut", level: 0, hostId: "cutter", kind: "interior", side: 3, t: 0.6, dir: 1 };
    const graph = buildCirculationGraph([room, cutter], 1, [door], false);
    const { segments, broken } = actorRoute(graph, [room, cutter], ["cutter", "room"]);
    expect(broken).toHaveLength(0);
    expect(segments).toHaveLength(1);
  });

  it("routes through a placed door's real position, not the wall's geometric midpoint", () => {
    const door: Arrow = { id: "d1", level: 0, hostId: "a", kind: "interior", side: 1, t: 0.75, dir: 1 };
    const graph = buildCirculationGraph([a, b, c], 1, [door], false);
    const { segments } = actorRoute(graph, [a, b, c], ["a", "b"]);
    expect(segments[0].pts[1][0]).toBeCloseTo(4, 6);
    expect(segments[0].pts[1][1]).toBeCloseTo(3, 6); // 75% down the wall, where the door actually is
  });

  it("ignores a door on one of the host's other walls -- it is not this wall's door, so there is still no route", () => {
    const door: Arrow = { id: "d2", level: 0, hostId: "a", kind: "interior", side: 0, t: 0.5, dir: 1 };
    const graph = buildCirculationGraph([a, b, c], 1, [door], false);
    const { segments, broken } = actorRoute(graph, [a, b, c], ["a", "b"]);
    expect(segments).toHaveLength(0);
    expect(broken).toEqual([{ fromId: "a", toId: "b" }]);
  });

  it("ignores an exterior door -- it leads outside, not into the other zone, so there is still no route", () => {
    const door: Arrow = { id: "d3", level: 0, hostId: "a", kind: "exterior-main", side: 1, t: 0.75, dir: 1 };
    const graph = buildCirculationGraph([a, b, c], 1, [door], false);
    const { segments, broken } = actorRoute(graph, [a, b, c], ["a", "b"]);
    expect(segments).toHaveLength(0);
    expect(broken).toEqual([{ fromId: "a", toId: "b" }]);
  });

  it("flags a servant's, a guest's or a diwaniya guest's route through a private zone, never the household's", () => {
    const bedroom = box({ id: "bedroom", left: 0, top: 0, width: 4, height: 4, roomType: "bedroom" });
    const kitchen = box({ id: "kitchen", left: 4, top: 0, width: 4, height: 4, roomType: "kitchen" });
    const byId = new Map([
      ["bedroom", bedroom],
      ["kitchen", kitchen],
    ]);
    expect(outOfBounds("servant", ["kitchen", "bedroom"], byId, zoneOf)).toBe(true);
    expect(outOfBounds("exterior", ["kitchen"], byId, zoneOf)).toBe(false);
    expect(outOfBounds("served", ["bedroom"], byId, zoneOf)).toBe(false);
    expect(outOfBounds("guest", ["bedroom"], byId, zoneOf)).toBe(true);
    expect(outOfBounds("guest", ["kitchen"], byId, zoneOf)).toBe(false);
  });

  it("holds a diwaniya guest to the diwaniya alone -- shared and service zones are out of bounds too", () => {
    const diwaniya = box({ id: "diwaniya", left: 0, top: 0, width: 6, height: 6, roomType: "diwaniya" });
    const living = box({ id: "living", left: 6, top: 0, width: 4, height: 4, roomType: "living_room" });
    const garage = box({ id: "garage", left: 0, top: 6, width: 4, height: 4, roomType: "garage_single" });
    const byId = new Map([
      ["diwaniya", diwaniya],
      ["living", living],
      ["garage", garage],
    ]);
    expect(outOfBounds("diwaniya_guest", ["diwaniya"], byId, zoneOf)).toBe(false);
    expect(outOfBounds("diwaniya_guest", ["diwaniya", "living"], byId, zoneOf)).toBe(true);
    expect(outOfBounds("diwaniya_guest", ["garage"], byId, zoneOf)).toBe(true);
    // The same living room is perfectly fine for a household guest.
    expect(outOfBounds("guest", ["living"], byId, zoneOf)).toBe(false);
  });

  it("finds the wall two actors' routes both cross, on the storey it happens on", () => {
    const graph = buildCirculationGraph([a, b, c], 1, DOORS, false);
    const owner = { actorId: "owner", segments: actorRoute(graph, [a, b, c], ["a", "c"]).segments };
    const staff = { actorId: "staff", segments: actorRoute(graph, [a, b, c], ["c", "a"]).segments };
    const shared = sharedSegments([owner, staff], 0);
    // Both walk the whole a-b-c corridor, in opposite directions: all
    // four of its stretches -- centre to door, door to centre, twice
    // over -- are shared.
    expect(shared).toHaveLength(4);
    expect(shared[0].actorIds.sort()).toEqual(["owner", "staff"]);
    // A different storey has none of it.
    expect(sharedSegments([owner, staff], 1)).toHaveLength(0);
  });

  it("finds nothing shared between routes that never cross", () => {
    const d = box({ id: "d", left: 0, top: 10, width: 4, height: 4 });
    const graph = buildCirculationGraph([a, b, c, d], 1, DOORS, false);
    const alone = { actorId: "alone", segments: actorRoute(graph, [a, b, c, d], ["a", "c"]).segments };
    expect(sharedSegments([alone], 0)).toHaveLength(0);
  });

  describe("against the real sample house", () => {
    const boxes = sampleBoxes();
    // The same door set the app itself starts a new project with:
    // the sample's own placed doors, plus whatever Suggest adds on
    // each storey -- mirroring state/store.ts's newProject().
    let arrows: Arrow[] = sampleArrows(boxes);
    for (let lv = 0; lv < SAMPLE_STOREYS; lv++) arrows = [...arrows, ...suggestArrows(liveBoxes(boxes, lv), arrows, lv, false)];
    const graph = buildCirculationGraph(boxes, SAMPLE_STOREYS, arrows, false);
    const byName = (name: string) => boxes.find((bx) => bx.name === name)!;

    it("crosses from the ground floor to storey 1 through the stair, not around it", () => {
      const primary = byName("Master Bedroom");
      const dining = byName("Dining Room");
      const { segments, broken } = actorRoute(graph, boxes, [primary.id, dining.id]);
      expect(broken).toHaveLength(0);
      const levels = new Set(segments.map((s) => s.level));
      expect(levels.has(1)).toBe(true);
      expect(levels.has(0)).toBe(true);
      expect(segments[0].pts[0]).toEqual(centerOf(rectOf(primary)));
      expect(segments[segments.length - 1].pts.at(-1)).toEqual(centerOf(rectOf(dining)));
    });

    it("routes from the garage to the dining room through the entry and living room -- the only doored way there", () => {
      // Kitchen touches a shorter path to the Dining Room geometrically,
      // but no door was placed on that shared wall -- so the honest
      // route is the longer one through Entry and Living Room.
      const { segments, broken } = actorRoute(graph, boxes, [byName("Garage").id, byName("Dining Room").id]);
      expect(broken).toHaveLength(0);
      expect(segments).toHaveLength(1);
      expect(segments[0].level).toBe(0);
      const entryCentre = centerOf(rectOf(byName("Entry")));
      expect(segments[0].pts.some((p) => p[0] === entryCentre[0] && p[1] === entryCentre[1])).toBe(true);
    });

    it("finds no direct route between the kitchen and the dining room -- they touch, but no door was placed on that wall", () => {
      const kitchen = byName("Kitchen");
      const dining = byName("Dining Room");
      expect((graph.get(kitchen.id) ?? []).some((e) => e.to === dining.id)).toBe(false);
      // The honest long way still exists, through the doors that are
      // actually there -- this is not a broken leg, just a longer one.
      const { segments, broken } = actorRoute(graph, boxes, [kitchen.id, dining.id]);
      expect(broken).toHaveLength(0);
      expect(segments).toHaveLength(1);
      const livingCentre = centerOf(rectOf(byName("Living Room")));
      expect(segments[0].pts.some((p) => p[0] === livingCentre[0] && p[1] === livingCentre[1])).toBe(true);
    });
  });
});

describe("arrow liveness: a door stays exactly where it was put, but is flagged once it is not a real one", () => {
  const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4 });
  const b = box({ id: "b", left: 4, top: 0, width: 3, height: 4 });
  // On a's right wall, at its own midpoint -- (4, 2) on the page.
  const door: Arrow = { id: "d", level: 0, hostId: "a", kind: "interior", side: 1, t: 0.5, dir: 1 };

  it("a plain door on an untouched, uncarved wall is live", () => {
    expect(liveArrowIds([a, b], 1, [door], false)).toEqual(new Set(["d"]));
  });

  it("flags a door once a carve removes the exact stretch of wall it sits on", () => {
    // The cutter eats the middle of a's right wall, right where the
    // door sits at y = 2 -- without a, b or the door itself moving.
    const cutter = box({ id: "cutter", left: 3, top: 1, width: 2, height: 2, carvedBy: [] });
    const carvedA: Box = { ...a, carvedBy: ["cutter"] };
    expect(liveArrowIds([carvedA, cutter], 1, [door], false).has("d")).toBe(false);
  });

  it("does not flag a door on a stretch of wall a carve left alone", () => {
    // This cutter only touches a's bottom-right corner (y 3..4), well
    // clear of the door's own position at y = 2.
    const cutter = box({ id: "cutter", left: 3, top: 3, width: 2, height: 2, carvedBy: [] });
    const carvedA: Box = { ...a, carvedBy: ["cutter"] };
    expect(liveArrowIds([carvedA, b, cutter], 1, [door], false).has("d")).toBe(true);
  });

  it("flags an interior door when the neighbour that used to be on its other side moves away, even though the host's own wall never changed", () => {
    const farB: Box = { ...b, left: 40, top: 0 };
    expect(liveArrowIds([a, farB], 1, [door], false).has("d")).toBe(false);
  });

  it("flags an exterior door once a carve removes the stretch of the host's own outline it sits on", () => {
    const ext: Arrow = { id: "e", level: 0, hostId: "a", kind: "exterior-main", side: 1, t: 0.5, dir: 1 };
    expect(liveArrowIds([a], 1, [ext], false).has("e")).toBe(true);
    const cutter = box({ id: "cutter", left: 3, top: 1, width: 2, height: 2, carvedBy: [] });
    const carvedA: Box = { ...a, carvedBy: ["cutter"] };
    expect(liveArrowIds([carvedA, cutter], 1, [ext], false).has("e")).toBe(false);
  });

  it("arrowIsLive is the same check liveArrowIds runs for every arrow, on demand for one", () => {
    const touchGraph = buildTouchGraph(new Map([["a", polyOfBox(a)], ["b", polyOfBox(b)]]), 0.04);
    const touches = (touchGraph.get("a") ?? []).map((e) => e.touch);
    expect(arrowIsLive(door, a, touches, polyOfBox(a))).toBe(true);
    expect(arrowIsLive(door, a, [], polyOfBox(a))).toBe(false);
  });
});

describe("syncFrozenArrowPoints: a live door's frozenAt tracks it, a stale one's is left exactly as it was", () => {
  const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4 });
  const b = box({ id: "b", left: 4, top: 0, width: 3, height: 4 });
  const door: Arrow = { id: "d", level: 0, hostId: "a", kind: "interior", side: 1, t: 0.5, dir: 1 };

  it("stamps frozenAt on a live arrow that does not have one yet", () => {
    const [synced] = syncFrozenArrowPoints([a, b], [door], false);
    expect(synced.frozenAt).toBeDefined();
    expect(synced.frozenAt![0][1]).toBeCloseTo(2, 6);
  });

  it("is a no-op, the very same array, once an arrow's frozenAt already matches its live position", () => {
    const [synced] = syncFrozenArrowPoints([a, b], [door], false);
    const again = syncFrozenArrowPoints([a, b], [synced], false);
    expect(again[0]).toBe(synced);
  });

  it("leaves frozenAt exactly as it is once the door goes stale, rather than following the raw wall formula", () => {
    const [live] = syncFrozenArrowPoints([a, b], [door], false);
    const cutter = box({ id: "cutter", left: 3, top: 1, width: 2, height: 2, carvedBy: [] });
    const carvedA: Box = { ...a, carvedBy: ["cutter"] };
    // Confirm it really did go stale, so this is the interesting case.
    expect(liveArrowIds([carvedA, b, cutter], 1, [live], false).has("d")).toBe(false);
    const [afterCarve] = syncFrozenArrowPoints([carvedA, b, cutter], [live], false);
    expect(afterCarve.frozenAt).toEqual(live.frozenAt);
  });

  it("does nothing for an arrow whose host does not exist", () => {
    const orphan: Arrow = { id: "o", level: 0, hostId: "gone", side: 0, t: 0.5, dir: 1 };
    const [synced] = syncFrozenArrowPoints([a, b], [orphan], false);
    expect(synced).toBe(orphan);
  });
});

describe("minHopCount: how many doors apart, not how many meters", () => {
  it("is 0 when a starting room is itself one of the targets", () => {
    const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4 });
    const graph = buildCirculationGraph([a], 1, [], false);
    expect(minHopCount(graph, ["a"], new Set(["a"]))).toBe(0);
  });

  it("is 1 for a direct door, 2 for one connecting room, growing with the walk", () => {
    // a - b - c, doored the whole way, a straight line.
    const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4 });
    const b = box({ id: "b", left: 4, top: 0, width: 3, height: 4 });
    const c = box({ id: "c", left: 7, top: 0, width: 4, height: 4 });
    const doors: Arrow[] = [
      { id: "d1", level: 0, hostId: "a", kind: "interior", side: 1, t: 0.5, dir: 1 },
      { id: "d2", level: 0, hostId: "b", kind: "interior", side: 1, t: 0.5, dir: 1 },
    ];
    const graph = buildCirculationGraph([a, b, c], 1, doors, false);
    expect(minHopCount(graph, ["a"], new Set(["b"]))).toBe(1);
    expect(minHopCount(graph, ["a"], new Set(["c"]))).toBe(2);
  });

  it("returns null when nothing in the targets is reachable at all", () => {
    const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4 });
    const isolated = box({ id: "isolated", left: 20, top: 20, width: 4, height: 4 });
    const graph = buildCirculationGraph([a, isolated], 1, [], false);
    expect(minHopCount(graph, ["a"], new Set(["isolated"]))).toBeNull();
  });

  it("is multi-source: the nearest of several starting rooms decides the answer", () => {
    // far - x - near - target: two candidate sources, one much closer.
    const far = box({ id: "far", left: 0, top: 0, width: 4, height: 4 });
    const x = box({ id: "x", left: 4, top: 0, width: 4, height: 4 });
    const near = box({ id: "near", left: 8, top: 0, width: 4, height: 4 });
    const target = box({ id: "target", left: 12, top: 0, width: 4, height: 4 });
    const doors: Arrow[] = [
      { id: "d1", level: 0, hostId: "far", kind: "interior", side: 1, t: 0.5, dir: 1 },
      { id: "d2", level: 0, hostId: "x", kind: "interior", side: 1, t: 0.5, dir: 1 },
      { id: "d3", level: 0, hostId: "near", kind: "interior", side: 1, t: 0.5, dir: 1 },
    ];
    const graph = buildCirculationGraph([far, x, near, target], 1, doors, false);
    expect(minHopCount(graph, ["far", "near"], new Set(["target"]))).toBe(1);
  });
});

describe("reachabilityProblems: every room reached from some exterior door, without walking through a non-passable one", () => {
  it("reports nothing for a plan every room is properly reached in", () => {
    const entry = box({ id: "entry", left: 0, top: 0, width: 4, height: 4, roomType: "entry" });
    const hall = box({ id: "hall", left: 4, top: 0, width: 3, height: 4, roomType: "hallway" });
    const bed = box({ id: "bed", left: 7, top: 0, width: 4, height: 4, roomType: "bedroom" });
    const arrows: Arrow[] = [
      { id: "ext", level: 0, hostId: "entry", kind: "exterior-main", side: 3, t: 0.5, dir: 1 },
      { id: "d1", level: 0, hostId: "entry", kind: "interior", side: 1, t: 0.5, dir: 1 },
      { id: "d2", level: 0, hostId: "hall", kind: "interior", side: 1, t: 0.5, dir: 1 },
    ];
    expect(reachabilityProblems([entry, hall, bed], 1, arrows, false, passableOf, auxiliaryOf, isServiceOf)).toEqual([]);
  });

  it("names the non-passable room that stands in the way, when that is the only route", () => {
    // entry -> garage -> bedroom, no other connection: the bedroom is
    // only reachable by walking through a garage, which is not passable.
    const entry = box({ id: "entry", left: 0, top: 0, width: 4, height: 4, roomType: "entry" });
    const garage = box({ id: "garage", left: 4, top: 0, width: 4, height: 4, roomType: "garage_single" });
    const bed = box({ id: "bed", left: 8, top: 0, width: 4, height: 4, roomType: "bedroom" });
    const arrows: Arrow[] = [
      { id: "ext", level: 0, hostId: "entry", kind: "exterior-main", side: 3, t: 0.5, dir: 1 },
      { id: "d1", level: 0, hostId: "entry", kind: "interior", side: 1, t: 0.5, dir: 1 },
      { id: "d2", level: 0, hostId: "garage", kind: "interior", side: 1, t: 0.5, dir: 1 },
    ];
    const problems = reachabilityProblems([entry, garage, bed], 1, arrows, false, passableOf, auxiliaryOf, isServiceOf);
    // The garage itself is reached (entry can walk into it); only the
    // bedroom beyond it, which nothing else reaches, is a problem.
    expect(problems).toEqual([{ roomId: "bed", kind: "through_room", viaIds: ["garage"], level: 0 }]);
  });

  it("reports a room with no doored connection to anything as unreachable, not through_room", () => {
    const entry = box({ id: "entry", left: 0, top: 0, width: 4, height: 4, roomType: "entry" });
    const isolated = box({ id: "isolated", left: 20, top: 20, width: 4, height: 4, roomType: "bedroom" });
    const arrows: Arrow[] = [{ id: "ext", level: 0, hostId: "entry", kind: "exterior-main", side: 3, t: 0.5, dir: 1 }];
    const problems = reachabilityProblems([entry, isolated], 1, arrows, false, passableOf, auxiliaryOf, isServiceOf);
    expect(problems).toEqual([{ roomId: "isolated", kind: "unreachable", viaIds: [], level: 0 }]);
  });

  it("treats a diwaniya's own street door as a second, independent root -- not only the main entry", () => {
    // entry and hallway form the household's own circulation, entirely
    // separate from the diwaniya, which sits elsewhere and reaches a
    // driver room only through its own exterior door.
    const entry = box({ id: "entry", left: 0, top: 0, width: 4, height: 4, roomType: "entry" });
    const hall = box({ id: "hall", left: 4, top: 0, width: 3, height: 4, roomType: "hallway" });
    const diwaniya = box({ id: "diwaniya", left: 20, top: 0, width: 6, height: 6, roomType: "diwaniya" });
    const driver = box({ id: "driver", left: 26, top: 0, width: 4, height: 4, roomType: "driver_room" });
    const arrows: Arrow[] = [
      { id: "extMain", level: 0, hostId: "entry", kind: "exterior-main", side: 3, t: 0.5, dir: 1 },
      { id: "d1", level: 0, hostId: "entry", kind: "interior", side: 1, t: 0.5, dir: 1 },
      { id: "extSide", level: 0, hostId: "diwaniya", kind: "exterior-side", side: 3, t: 0.5, dir: 1 },
      { id: "d2", level: 0, hostId: "diwaniya", kind: "interior", side: 1, t: 0.5, dir: 1 },
    ];
    const problems = reachabilityProblems([entry, hall, diwaniya, driver], 1, arrows, false, passableOf, auxiliaryOf, isServiceOf);
    // Nothing is unreachable: the driver room is reached via the
    // diwaniya's own door, and the diwaniya itself is a root, so it is
    // never reported even though it is not passable.
    expect(problems).toEqual([]);
  });

  it("does not flag an ensuite bathroom reached only through its own bedroom", () => {
    const entry = box({ id: "entry", left: 0, top: 0, width: 4, height: 4, roomType: "entry" });
    const bed = box({ id: "bed", left: 4, top: 0, width: 4, height: 4, roomType: "bedroom" });
    const ensuite = box({ id: "ensuite", left: 8, top: 0, width: 2, height: 2, roomType: "bathroom" });
    const arrows: Arrow[] = [
      { id: "ext", level: 0, hostId: "entry", kind: "exterior-main", side: 3, t: 0.5, dir: 1 },
      { id: "d1", level: 0, hostId: "entry", kind: "interior", side: 1, t: 0.5, dir: 1 },
      { id: "d2", level: 0, hostId: "bed", kind: "interior", side: 1, t: 0.5, dir: 1 },
    ];
    const problems = reachabilityProblems([entry, bed, ensuite], 1, arrows, false, passableOf, auxiliaryOf, isServiceOf);
    // The bedroom itself is fine (reached from entry); the ensuite, an
    // auxiliary type gated only by a non-Service room, is not reported
    // even though nothing continues walking past the bedroom to it.
    expect(problems).toEqual([]);
  });

  it("still flags an auxiliary room reached only through a Service room -- the exemption is narrow, not blanket", () => {
    const entry = box({ id: "entry", left: 0, top: 0, width: 4, height: 4, roomType: "entry" });
    const garage = box({ id: "garage", left: 4, top: 0, width: 4, height: 4, roomType: "garage_single" });
    const bath = box({ id: "bath", left: 8, top: 0, width: 2, height: 2, roomType: "bathroom" });
    const arrows: Arrow[] = [
      { id: "ext", level: 0, hostId: "entry", kind: "exterior-main", side: 3, t: 0.5, dir: 1 },
      { id: "d1", level: 0, hostId: "entry", kind: "interior", side: 1, t: 0.5, dir: 1 },
      { id: "d2", level: 0, hostId: "garage", kind: "interior", side: 1, t: 0.5, dir: 1 },
    ];
    const problems = reachabilityProblems([entry, garage, bath], 1, arrows, false, passableOf, auxiliaryOf, isServiceOf);
    expect(problems).toEqual([{ roomId: "bath", kind: "through_room", viaIds: ["garage"], level: 0 }]);
  });
});

describe("checkAdjacency: required/desired need a real door; undesired only cares about touching", () => {
  it("does NOT satisfy a required pair by touching alone -- a shared wall with no door is not walkable", () => {
    // The exact case a real house turned up: two rooms sharing a wall
    // with nothing cut into it. Adjacency-on-paper is not the same as
    // being able to actually walk between them.
    const kitchen = box({ id: "kitchen", left: 0, top: 0, width: 4, height: 4, roomType: "kitchen" });
    const dining = box({ id: "dining", left: 4, top: 0, width: 4, height: 4, roomType: "dining_room" });
    const row = checkAdjacency([kitchen, dining], 1, [], false).find((r) => r.a === "kitchen" && r.b === "dining_room");
    expect(row?.relation).toBe("required");
    expect(row?.ok).toBe(false);
    // Distinguishable from not being near each other at all -- this is
    // what lets a message say "there's a wall but no door" rather than
    // "these aren't even adjacent," which would be simply wrong here.
    expect(row?.touching).toBe(true);
  });

  it("satisfies a required pair once an actual door connects them", () => {
    const kitchen = box({ id: "kitchen", left: 0, top: 0, width: 4, height: 4, roomType: "kitchen" });
    const dining = box({ id: "dining", left: 4, top: 0, width: 4, height: 4, roomType: "dining_room" });
    const door: Arrow = { id: "d", level: 0, hostId: "kitchen", kind: "interior", side: 1, t: 0.5, dir: 1 };
    const row = checkAdjacency([kitchen, dining], 1, [door], false).find((r) => r.a === "kitchen" && r.b === "dining_room");
    expect(row?.ok).toBe(true);
  });

  it("fails a required pair when both types exist but do not even touch", () => {
    const kitchen = box({ id: "kitchen", left: 0, top: 0, width: 4, height: 4, roomType: "kitchen" });
    const dining = box({ id: "dining", left: 20, top: 20, width: 4, height: 4, roomType: "dining_room" });
    const row = checkAdjacency([kitchen, dining], 1, [], false).find((r) => r.a === "kitchen" && r.b === "dining_room");
    expect(row?.ok).toBe(false);
    expect(row?.touching).toBe(false);
  });

  it("leaves a row out entirely when one of its two room types is absent -- never reported as failing", () => {
    const kitchen = box({ id: "kitchen", left: 0, top: 0, width: 4, height: 4, roomType: "kitchen" });
    const rows = checkAdjacency([kitchen], 1, [], false);
    expect(rows.find((r) => r.a === "kitchen" && r.b === "dining_room")).toBeUndefined();
  });

  it("flags an undesired pair that merely touches -- no door needed for this one to be a problem", () => {
    const bedroom = box({ id: "bedroom", left: 0, top: 0, width: 4, height: 4, roomType: "bedroom" });
    const garageTouching = box({ id: "g1", left: 4, top: 0, width: 4, height: 4, roomType: "garage_single" });
    const touchingRow = checkAdjacency([bedroom, garageTouching], 1, [], false).find((r) => r.a === "bedroom" && r.b === "garage_single");
    expect(touchingRow?.relation).toBe("undesired");
    expect(touchingRow?.ok).toBe(false);

    const garageFar = box({ id: "g2", left: 30, top: 30, width: 4, height: 4, roomType: "garage_single" });
    const farRow = checkAdjacency([bedroom, garageFar], 1, [], false).find((r) => r.a === "bedroom" && r.b === "garage_single");
    expect(farRow?.ok).toBe(true);
  });

  it("an untagged extra instance of the same type does not break the old at-least-one check -- no regression", () => {
    // A master ensuite (with a real door) plus a completely unrelated
    // hall bathroom (not touching, not tagged): the type-level check
    // still passes, exactly as it always has, because neither instance
    // declares an owner for this test to hold accountable.
    const master = box({ id: "master", left: 0, top: 0, width: 6, height: 6, roomType: "master_bedroom" });
    const ensuite = box({ id: "ensuite", left: 6, top: 0, width: 2, height: 2, roomType: "bathroom" });
    const hallBath = box({ id: "hallBath", left: 30, top: 30, width: 2, height: 2, roomType: "bathroom" });
    const door: Arrow = { id: "d", level: 0, hostId: "ensuite", kind: "interior", side: 3, t: 0.5, dir: 1 };
    const row = checkAdjacency([master, ensuite, hallBath], 1, [door], false).find((r) => r.a === "master_bedroom" && r.b === "bathroom");
    expect(row?.ok).toBe(true);
    expect(row?.failedInstanceIds).toEqual([]);
  });

  it("catches a declared attachment that does not actually connect to its claimed owner -- the his-and-hers case", () => {
    const master = box({ id: "master", left: 0, top: 0, width: 6, height: 6, roomType: "master_bedroom" });
    // His bathroom really does have a door into the master bedroom.
    const hisBath = box({ id: "hisBath", left: 6, top: 0, width: 2, height: 2, roomType: "bathroom", attachedTo: "master" });
    const hisDoor: Arrow = { id: "d1", level: 0, hostId: "hisBath", kind: "interior", side: 3, t: 0.5, dir: 1 };
    // Her bathroom claims the master bedroom too, but sits nowhere near
    // it -- the placement mistake this check exists to catch.
    const herBath = box({ id: "herBath", left: 30, top: 30, width: 2, height: 2, roomType: "bathroom", attachedTo: "master" });
    const row = checkAdjacency([master, hisBath, herBath], 1, [hisDoor], false).find((r) => r.a === "master_bedroom" && r.b === "bathroom");
    // Type-level "at least one connects" would have said true here (his
    // bathroom alone satisfies it) -- the declared, unmet claim is what
    // correctly fails the row instead.
    expect(row?.ok).toBe(false);
    expect(row?.failedInstanceIds).toEqual(["herBath"]);
  });

  it("passes when both declared attachments actually have a real door to their claimed owner", () => {
    const master = box({ id: "master", left: 0, top: 0, width: 6, height: 6, roomType: "master_bedroom" });
    const hisBath = box({ id: "hisBath", left: 6, top: 0, width: 2, height: 2, roomType: "bathroom", attachedTo: "master" });
    const herBath = box({ id: "herBath", left: 0, top: 6, width: 6, height: 2, roomType: "bathroom", attachedTo: "master" });
    const doors: Arrow[] = [
      { id: "d1", level: 0, hostId: "hisBath", kind: "interior", side: 3, t: 0.5, dir: 1 },
      { id: "d2", level: 0, hostId: "herBath", kind: "interior", side: 0, t: 0.5, dir: 1 },
    ];
    const row = checkAdjacency([master, hisBath, herBath], 1, doors, false).find((r) => r.a === "master_bedroom" && r.b === "bathroom");
    expect(row?.ok).toBe(true);
    expect(row?.failedInstanceIds).toEqual([]);
  });

  it("satisfies a desired pair on easy access -- a direct door counts", () => {
    const kitchen = box({ id: "kitchen", left: 0, top: 0, width: 4, height: 4, roomType: "kitchen" });
    const laundry = box({ id: "laundry", left: 4, top: 0, width: 4, height: 4, roomType: "laundry" });
    const door: Arrow = { id: "d", level: 0, hostId: "kitchen", kind: "interior", side: 1, t: 0.5, dir: 1 };
    const row = checkAdjacency([kitchen, laundry], 1, [door], false).find((r) => r.a === "kitchen" && r.b === "laundry");
    expect(row?.relation).toBe("desired");
    expect(row?.ok).toBe(true);
  });

  it("satisfies a desired pair through one connecting room, without the two ever touching each other", () => {
    const kitchen = box({ id: "kitchen", left: 0, top: 0, width: 4, height: 4, roomType: "kitchen" });
    const hall = box({ id: "hall", left: 4, top: 0, width: 3, height: 4, roomType: "hallway" });
    const laundry = box({ id: "laundry", left: 7, top: 0, width: 4, height: 4, roomType: "laundry" });
    const doors: Arrow[] = [
      { id: "d1", level: 0, hostId: "kitchen", kind: "interior", side: 1, t: 0.5, dir: 1 },
      { id: "d2", level: 0, hostId: "hall", kind: "interior", side: 1, t: 0.5, dir: 1 },
    ];
    const row = checkAdjacency([kitchen, hall, laundry], 1, doors, false).find((r) => r.a === "kitchen" && r.b === "laundry");
    expect(row?.touching).toBe(false);
    expect(row?.ok).toBe(true);
  });

  it("fails a desired pair three or more rooms apart -- not \"easy\" any more", () => {
    const kitchen = box({ id: "kitchen", left: 0, top: 0, width: 4, height: 4, roomType: "kitchen" });
    const h1 = box({ id: "h1", left: 4, top: 0, width: 3, height: 4, roomType: "hallway" });
    const h2 = box({ id: "h2", left: 7, top: 0, width: 3, height: 4, roomType: "hallway" });
    const laundry = box({ id: "laundry", left: 10, top: 0, width: 4, height: 4, roomType: "laundry" });
    const doors: Arrow[] = [
      { id: "d1", level: 0, hostId: "kitchen", kind: "interior", side: 1, t: 0.5, dir: 1 },
      { id: "d2", level: 0, hostId: "h1", kind: "interior", side: 1, t: 0.5, dir: 1 },
      { id: "d3", level: 0, hostId: "h2", kind: "interior", side: 1, t: 0.5, dir: 1 },
    ];
    const row = checkAdjacency([kitchen, h1, h2, laundry], 1, doors, false).find((r) => r.a === "kitchen" && r.b === "laundry");
    expect(row?.ok).toBe(false);
  });

  it("still evaluates a desired pair across two storeys, reached only through a stair", () => {
    const kitchen = box({ id: "kitchen", left: 0, top: 0, width: 4, height: 4, roomType: "kitchen", level: 0, levelTo: 0 });
    const stair = box({ id: "stair", left: 4, top: 0, width: 2, height: 4, roomType: "stair", level: 0, levelTo: 1 });
    const laundry = box({ id: "laundry", left: 6, top: 0, width: 4, height: 4, roomType: "laundry", level: 1, levelTo: 1 });
    const doors: Arrow[] = [
      { id: "d1", level: 0, hostId: "kitchen", kind: "interior", side: 1, t: 0.5, dir: 1 },
      { id: "d2", level: 1, hostId: "stair", kind: "interior", side: 1, t: 0.5, dir: 1 },
    ];
    const row = checkAdjacency([kitchen, stair, laundry], 2, doors, false).find((r) => r.a === "kitchen" && r.b === "laundry");
    // Present at all (a same-storey-only check would have skipped this
    // row entirely, since kitchen and laundry never share a floor), and
    // satisfied at 2 hops via the stair.
    expect(row).toBeDefined();
    expect(row?.ok).toBe(true);
  });
});

describe("tierViolations: a real door may connect adjacent tiers, never skip one", () => {
  it("flags a door straight from a Public room to a Private one", () => {
    const entry = box({ id: "entry", left: 0, top: 0, width: 4, height: 4, roomType: "entry" });
    const bed = box({ id: "bed", left: 4, top: 0, width: 4, height: 4, roomType: "bedroom" });
    const door: Arrow = { id: "d", level: 0, hostId: "entry", kind: "interior", side: 1, t: 0.5, dir: 1 };
    const violations = tierViolations([entry, bed], 1, [door], false, tierOf);
    // One unordered result per doored pair -- which side lands in roomAId
    // vs roomBId is not part of the contract, so check membership rather
    // than a fixed order.
    expect(violations).toHaveLength(1);
    expect([violations[0].roomAId, violations[0].roomBId].sort()).toEqual(["bed", "entry"]);
    expect([violations[0].tierA, violations[0].tierB].sort()).toEqual(["private", "public"]);
  });

  it("clears a Public-to-Private connection once a Semi-public room stands between them", () => {
    const entry = box({ id: "entry", left: 0, top: 0, width: 4, height: 4, roomType: "entry" });
    const hall = box({ id: "hall", left: 4, top: 0, width: 3, height: 4, roomType: "hallway" });
    const bed = box({ id: "bed", left: 7, top: 0, width: 4, height: 4, roomType: "bedroom" });
    const doors: Arrow[] = [
      { id: "d1", level: 0, hostId: "entry", kind: "interior", side: 1, t: 0.5, dir: 1 },
      { id: "d2", level: 0, hostId: "hall", kind: "interior", side: 1, t: 0.5, dir: 1 },
    ];
    expect(tierViolations([entry, hall, bed], 1, doors, false, tierOf)).toEqual([]);
  });

  it("never flags a bathroom either side, since bathrooms are exempt from the gradient", () => {
    const entry = box({ id: "entry", left: 0, top: 0, width: 4, height: 4, roomType: "entry" });
    const bath = box({ id: "bath", left: 4, top: 0, width: 2, height: 2, roomType: "bathroom" });
    const door: Arrow = { id: "d", level: 0, hostId: "entry", kind: "interior", side: 1, t: 0.5, dir: 1 };
    expect(tierViolations([entry, bath], 1, [door], false, tierOf)).toEqual([]);
  });

  it("respects a per-instance privacyTierOverride instead of the room type's default", () => {
    const entry = box({ id: "entry", left: 0, top: 0, width: 4, height: 4, roomType: "entry" });
    const office = box({ id: "office", left: 4, top: 0, width: 4, height: 4, roomType: "office" });
    const door: Arrow = { id: "d", level: 0, hostId: "entry", kind: "interior", side: 1, t: 0.5, dir: 1 };
    // Office defaults to Private -- two tiers from Public, so this flags.
    expect(tierViolations([entry, office], 1, [door], false, tierOf)).toHaveLength(1);
    // Overridden to Public on this one instance, it no longer does.
    const overridden: Box = { ...office, privacyTierOverride: "public" };
    expect(tierViolations([entry, overridden], 1, [door], false, tierOf)).toEqual([]);
  });
});

describe("collectFindings: the one call that ties all three checks together", () => {
  it("returns each check's own result under its own key, computed fresh, nothing cached", () => {
    const entry = box({ id: "entry", left: 0, top: 0, width: 4, height: 4, roomType: "entry" });
    const bed = box({ id: "bed", left: 4, top: 0, width: 4, height: 4, roomType: "bedroom" });
    const ext: Arrow = { id: "ext", level: 0, hostId: "entry", kind: "exterior-main", side: 3, t: 0.5, dir: 1 };
    const door: Arrow = { id: "d", level: 0, hostId: "entry", kind: "interior", side: 1, t: 0.5, dir: 1 };
    const findings = collectFindings([entry, bed], 1, [ext, door], false, passableOf, tierOf, auxiliaryOf, isServiceOf, circulationOf);
    // Same door, evaluated three different ways: it does connect the
    // household to the entry (no reachability problem), it is not a
    // room-type pair the adjacency table has an opinion on, and it does
    // skip a privacy tier. No stair involved at all, so nothing there either.
    expect(findings.reachability).toEqual([]);
    expect(findings.adjacency).toEqual([]);
    expect(findings.tier).toHaveLength(1);
    expect(findings.stairConnection).toEqual([]);
  });
});

describe("stairConnectionProblems: a stair should open onto circulation, not a specific room", () => {
  it("reports nothing when a stair opens onto a hallway", () => {
    const stair = box({ id: "stair", left: 0, top: 0, width: 4, height: 4, roomType: "stair" });
    const hall = box({ id: "hall", left: 4, top: 0, width: 3, height: 4, roomType: "hallway" });
    const door: Arrow = { id: "d", level: 0, hostId: "stair", kind: "interior", side: 1, t: 0.5, dir: 1 };
    expect(stairConnectionProblems([stair, hall], 1, [door], false, circulationOf)).toEqual([]);
  });

  it("reports nothing when a stair opens onto the entry, or onto another stair", () => {
    const stair = box({ id: "stair", left: 0, top: 0, width: 4, height: 4, roomType: "stair" });
    const entry = box({ id: "entry", left: 4, top: 0, width: 3, height: 4, roomType: "entry" });
    const door: Arrow = { id: "d", level: 0, hostId: "stair", kind: "interior", side: 1, t: 0.5, dir: 1 };
    expect(stairConnectionProblems([stair, entry], 1, [door], false, circulationOf)).toEqual([]);
  });

  it("flags a stair that opens straight into a bedroom", () => {
    const stair = box({ id: "stair", left: 0, top: 0, width: 4, height: 4, roomType: "stair" });
    const bed = box({ id: "bed", left: 4, top: 0, width: 4, height: 4, roomType: "bedroom" });
    const door: Arrow = { id: "d", level: 0, hostId: "stair", kind: "interior", side: 1, t: 0.5, dir: 1 };
    const problems = stairConnectionProblems([stair, bed], 1, [door], false, circulationOf);
    expect(problems).toEqual([{ stairId: "stair", otherRoomId: "bed", otherRoomType: "bedroom", level: 0 }]);
  });
});

describe("scoreCandidate and compareScores: hard problems always decide first", () => {
  const score = (boxes: Box[], arrows: Arrow[] = []) =>
    scoreCandidate(boxes, 1, arrows, false, passableOf, tierOf, auxiliaryOf, isServiceOf, circulationOf);

  it("scores a genuinely clean candidate 0 and 0", () => {
    const entry = box({ id: "entry", left: 0, top: 0, width: 4, height: 4, roomType: "entry" });
    const ext: Arrow = { id: "ext", level: 0, hostId: "entry", kind: "exterior-main", side: 3, t: 0.5, dir: 1 };
    const s = score([entry], [ext]);
    expect(s.hardProblems).toBe(0);
    expect(s.softRecommendations).toBe(0);
  });

  it("counts a reachability problem as hard, not soft", () => {
    // Entry has its own exterior door; Living Room touches it but has no
    // door of its own, so it's unreached -- one hard problem, and no
    // adjacency row involves Living Room at all, so nothing soft.
    const entry = box({ id: "entry", left: 0, top: 0, width: 4, height: 4, roomType: "entry" });
    const living = box({ id: "living", left: 4, top: 0, width: 4, height: 4, roomType: "living_room" });
    const ext: Arrow = { id: "ext", level: 0, hostId: "entry", kind: "exterior-main", side: 3, t: 0.5, dir: 1 };
    const s = score([entry, living], [ext]);
    expect(s.hardProblems).toBe(1);
    expect(s.softRecommendations).toBe(0);
    expect(s.findings.reachability).toHaveLength(1);
  });

  it("counts an unmet desired row as soft, separately from the hard problems it also causes", () => {
    // Kitchen and Laundry, alone, no doors at all: both are unreachable
    // (two hard problems) *and* the desired kitchen-laundry pair is
    // unmet (one soft recommendation) -- two different checks, counted
    // independently, neither one masking the other.
    const kitchen = box({ id: "kitchen", left: 0, top: 0, width: 4, height: 4, roomType: "kitchen" });
    const laundry = box({ id: "laundry", left: 20, top: 20, width: 4, height: 4, roomType: "laundry" });
    const s = score([kitchen, laundry]);
    expect(s.hardProblems).toBe(2);
    expect(s.softRecommendations).toBe(1);
  });

  it("a candidate with zero hard problems always outranks one with any, however many recommendations it's missing", () => {
    const empty = { reachability: [], adjacency: [], tier: [], stairConnection: [] };
    const worseHard = { hardProblems: 1, softRecommendations: 0, findings: empty };
    const worseSoft = { hardProblems: 0, softRecommendations: 5, findings: empty };
    expect(compareScores(worseSoft, worseHard)).toBeLessThan(0);
  });

  it("among equal hard problems, fewer recommendations wins", () => {
    const empty = { reachability: [], adjacency: [], tier: [], stairConnection: [] };
    const moreSoft = { hardProblems: 2, softRecommendations: 3, findings: empty };
    const fewerSoft = { hardProblems: 2, softRecommendations: 1, findings: empty };
    expect(compareScores(fewerSoft, moreSoft)).toBeLessThan(0);
    expect(compareScores(moreSoft, fewerSoft)).toBeGreaterThan(0);
  });

  it("is 0 when both counts match", () => {
    const empty = { reachability: [], adjacency: [], tier: [], stairConnection: [] };
    const a = { hardProblems: 1, softRecommendations: 1, findings: empty };
    const b = { hardProblems: 1, softRecommendations: 1, findings: empty };
    expect(compareScores(a, b)).toBe(0);
  });
});

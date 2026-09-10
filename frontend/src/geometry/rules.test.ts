/**
 * The rules added by the batch that began after `scenarios.baseline.json`
 * was frozen -- kept in their own file rather than appended to
 * `geometry.test.ts`, which is already long and organized around the
 * original checks. Same tiers and same conventions as everything else
 * under `geometry/`: pure functions, no DOM, no store, small hand-built
 * fixtures whose defect is visible in the fixture itself.
 *
 * Every rule here is tested the same way, and the shape is deliberate:
 * one arrangement that violates it and one that does not, differing in
 * the one thing the rule is actually about. A test that only proves the
 * rule fires proves nothing about whether it fires on everything.
 */
import { describe, expect, it } from "vitest";

import { awkwardProportions, exteriorWallLength, singleAspectRooms, windowlessSleepingRooms } from "./habitability";
import { checkAdjacency, sanitaryDoorProblems, scoreCandidate, undersizedDoorways, type RelationRow } from "./relationships";
import type { Arrow, Box } from "./types";
import { foodOf, habitableOf, ROOM_FACTS, sanitaryOf, sleepingOf } from "../rooms";

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
    minWidth: 0.5,
    minHeight: 0.5,
    rotation: 0,
    priority: 2,
    carvedBy: [],
    deleted: false,
    initial: { left: partial.left, top: partial.top, width: partial.width, height: partial.height },
    ...partial,
  };
}

/** A door on `hostId`'s own side `side` -- 0 top, 1 right, 2 bottom,
 * 3 left, `rect.ts`'s convention, the same one every other fixture in
 * this codebase uses. */
function door(id: string, hostId: string, side: number, t = 0.5): Arrow {
  return { id, level: 0, hostId, kind: "interior", side, t, dir: 1 };
}

describe("sanitaryDoorProblems: a WC does not open onto a room used for food", () => {
  // A bathroom immediately right of a kitchen, with a door between them.
  const kitchen = box({ id: "kitchen", left: 0, top: 0, width: 4, height: 4, roomType: "kitchen" });
  const wc = box({ id: "wc", left: 4, top: 0, width: 2, height: 2.5, roomType: "half_bath" });

  it("reports the doorway when a WC opens straight into a kitchen", () => {
    const problems = sanitaryDoorProblems([kitchen, wc], 1, [door("d", "kitchen", 1, 0.3)], false, sanitaryOf, foodOf);
    expect(problems).toEqual([{ sanitaryId: "wc", foodRoomId: "kitchen", foodRoomType: "kitchen", level: 0 }]);
  });

  it("reports the doorway when a WC opens straight into a dining room", () => {
    const dining = { ...kitchen, roomType: "dining_room" };
    const problems = sanitaryDoorProblems([dining, wc], 1, [door("d", "kitchen", 1, 0.3)], false, sanitaryOf, foodOf);
    expect(problems).toHaveLength(1);
    expect(problems[0].foodRoomType).toBe("dining_room");
  });

  it("reports nothing when the two merely share a wall with no door in it", () => {
    // The whole point of reading the door graph rather than the touch
    // graph: a WC backing onto a kitchen is normal and often deliberate,
    // since it puts both rooms' plumbing on one stack. Only the doorway
    // is the defect.
    expect(sanitaryDoorProblems([kitchen, wc], 1, [], false, sanitaryOf, foodOf)).toEqual([]);
  });

  it("reports nothing when a hall sits between the WC and the kitchen", () => {
    // kitchen | hall | wc, a door at each junction -- the arrangement the
    // convention actually asks for, and the one a naive "these two are
    // near each other" rule would have wrongly flagged.
    const hall = box({ id: "hall", left: 4, top: 0, width: 1.5, height: 4, roomType: "hallway", kind: "corridor" });
    const wcBeyond = box({ id: "wc", left: 5.5, top: 0, width: 2, height: 2.5, roomType: "half_bath" });
    const arrows = [door("d1", "kitchen", 1, 0.3), door("d2", "hall", 1, 0.2)];
    expect(sanitaryDoorProblems([kitchen, hall, wcBeyond], 1, arrows, false, sanitaryOf, foodOf)).toEqual([]);
  });

  it("reports nothing for a powder room off an entrance hall or an ensuite off a bedroom", () => {
    const entry = box({ id: "entry", left: 0, top: 0, width: 4, height: 4, roomType: "entry" });
    const powder = box({ id: "powder", left: 4, top: 0, width: 2, height: 2.5, roomType: "half_bath" });
    expect(sanitaryDoorProblems([entry, powder], 1, [door("d", "entry", 1, 0.3)], false, sanitaryOf, foodOf)).toEqual([]);

    const bed = box({ id: "bed", left: 0, top: 0, width: 4, height: 4, roomType: "bedroom" });
    const ensuite = box({ id: "ensuite", left: 4, top: 0, width: 2, height: 2.5, roomType: "bathroom" });
    expect(sanitaryDoorProblems([bed, ensuite], 1, [door("d", "bed", 1, 0.3)], false, sanitaryOf, foodOf)).toEqual([]);
  });

  it("counts as a hard problem in scoreCandidate, not a recommendation", () => {
    // An entry with its own front door, a kitchen off it, and a WC opening
    // straight off the kitchen: everything is reachable and no tier is
    // skipped, so the WC doorway is the only hard problem left to find.
    const entry = box({ id: "entry", left: 0, top: 0, width: 3, height: 4, roomType: "entry", isEntry: true });
    const kit = box({ id: "kit", left: 3, top: 0, width: 4, height: 4, roomType: "kitchen" });
    const bath = box({ id: "bath", left: 7, top: 0, width: 2, height: 2.5, roomType: "half_bath" });
    const arrows: Arrow[] = [
      { id: "ext", level: 0, hostId: "entry", kind: "exterior-main", side: 3, t: 0.5, dir: 1 },
      door("d1", "entry", 1, 0.5),
      door("d2", "kit", 1, 0.3),
    ];
    const withWc = scoreCandidate([entry, kit, bath], 1, arrows, false, ROOM_FACTS, []);
    const withoutWc = scoreCandidate([entry, kit], 1, arrows.slice(0, 2), false, ROOM_FACTS, []);
    expect(withWc.findings.sanitaryDoors).toHaveLength(1);
    expect(withWc.hardProblems).toBe(withoutWc.hardProblems + 1);
  });
});

describe("garage to kitchen: the service route shopping is carried along", () => {
  const rules: RelationRow[] = [{ a: "garage_single", b: "kitchen", relation: "desired" }];

  const garage = box({ id: "garage", left: 0, top: 0, width: 4, height: 6, roomType: "garage_single" });
  const mud = box({ id: "mud", left: 4, top: 0, width: 2, height: 3, roomType: "mudroom" });
  const kitchen = box({ id: "kitchen", left: 6, top: 0, width: 4, height: 4, roomType: "kitchen" });

  it("is satisfied by garage -> mudroom -> kitchen, which is the arrangement it asks for", () => {
    const arrows = [door("d1", "garage", 1, 0.25), door("d2", "mud", 1, 0.5)];
    const rows = checkAdjacency([garage, mud, kitchen], 1, arrows, false, rules);
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(true);
  });

  it("fails when the kitchen is a long way from the garage", () => {
    // Garage, mudroom, a hall, a laundry, then the kitchen: four doors
    // from car to counter, well past the two-hop "easy access" this row
    // means by `desired`.
    const hall = box({ id: "hall", left: 6, top: 0, width: 1.5, height: 6, roomType: "hallway", kind: "corridor" });
    const laundry = box({ id: "laundry", left: 7.5, top: 0, width: 3, height: 3, roomType: "laundry" });
    const far = box({ id: "kitchen", left: 10.5, top: 0, width: 4, height: 4, roomType: "kitchen" });
    const arrows = [door("d1", "garage", 1, 0.25), door("d2", "mud", 1, 0.5), door("d3", "hall", 1, 0.2), door("d4", "laundry", 1, 0.5)];
    const rows = checkAdjacency([garage, mud, hall, laundry, far], 1, arrows, false, rules);
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
  });

  it("is a soft recommendation, never a hard problem", () => {
    // `desired` is the whole point of choosing this relation: a house
    // whose kitchen is far from the garage is inconvenient, not broken.
    const hall = box({ id: "hall", left: 6, top: 0, width: 1.5, height: 6, roomType: "hallway", kind: "corridor" });
    const laundry = box({ id: "laundry", left: 7.5, top: 0, width: 3, height: 3, roomType: "laundry" });
    const far = box({ id: "kitchen", left: 10.5, top: 0, width: 4, height: 4, roomType: "kitchen" });
    const arrows: Arrow[] = [
      { id: "ext", level: 0, hostId: "garage", kind: "exterior-side", side: 3, t: 0.5, dir: 1 },
      door("d1", "garage", 1, 0.25),
      door("d2", "mud", 1, 0.5),
      door("d3", "hall", 1, 0.2),
      door("d4", "laundry", 1, 0.5),
    ];
    // Scored with and without this one row, over the identical plan, so
    // whatever else this fixture happens to score (it has a real
    // dead-end corridor in it) is held constant and only the row's own
    // contribution is measured.
    const rooms = [garage, mud, hall, laundry, far];
    const withRow = scoreCandidate(rooms, 1, arrows, false, ROOM_FACTS, rules);
    const withoutRow = scoreCandidate(rooms, 1, arrows, false, ROOM_FACTS, []);
    expect(withRow.hardProblems).toBe(withoutRow.hardProblems);
    expect(withRow.softRecommendations).toBeCloseTo(withoutRow.softRecommendations + 1, 6);
  });
});

describe("undersizedDoorways: a door needs enough shared wall to exist", () => {
  it("reports a door drawn across a sliver of shared wall", () => {
    // Two rooms overlapping by 30 cm at their corners: real shared wall,
    // far too little of it to cut a 762 mm leaf plus frame into.
    const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4, roomType: "hallway", kind: "corridor" });
    const b = box({ id: "b", left: 4, top: 3.7, width: 4, height: 4, roomType: "bedroom" });
    const found = undersizedDoorways([a, b], 1, [door("d", "a", 1, 0.96)], false);
    expect(found).toHaveLength(1);
    expect(found[0].wallM).toBeCloseTo(0.3, 3);
  });

  it("reports nothing when the two rooms share a full wall", () => {
    const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4, roomType: "hallway", kind: "corridor" });
    const b = box({ id: "b", left: 4, top: 0, width: 4, height: 4, roomType: "bedroom" });
    expect(undersizedDoorways([a, b], 1, [door("d", "a", 1, 0.5)], false)).toEqual([]);
  });

  it("reports nothing when the sliver has no door drawn on it", () => {
    // Same geometry as the first case, no door: two rooms clipping past
    // each other is not a defect on its own. Only the claimed doorway is.
    const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4, roomType: "hallway", kind: "corridor" });
    const b = box({ id: "b", left: 4, top: 3.7, width: 4, height: 4, roomType: "bedroom" });
    expect(undersizedDoorways([a, b], 1, [], false)).toEqual([]);
  });

  it("weights the shortfall: a wall barely short counts for far less than a sliver", () => {
    const wide = box({ id: "a", left: 0, top: 0, width: 4, height: 4, roomType: "hallway", kind: "corridor" });
    const nearlyEnough = box({ id: "b", left: 4, top: 3.15, width: 4, height: 4, roomType: "bedroom" });
    const sliver = box({ id: "b", left: 4, top: 3.9, width: 4, height: 4, roomType: "bedroom" });
    const arrows = [door("d", "a", 1, 0.96)];
    const near = scoreCandidate([wide, nearlyEnough], 1, arrows, false, ROOM_FACTS, []);
    const thin = scoreCandidate([wide, sliver], 1, arrows, false, ROOM_FACTS, []);
    expect(near.findings.undersizedDoorways).toHaveLength(1);
    expect(thin.findings.undersizedDoorways).toHaveLength(1);
    expect(thin.hardProblems).toBeGreaterThan(near.hardProblems);
  });

  it("counts as a hard problem, weighted by how far short the wall falls", () => {
    const a = box({ id: "a", left: 0, top: 0, width: 4, height: 4, roomType: "hallway", kind: "corridor", isEntry: true });
    const b = box({ id: "b", left: 4, top: 3.7, width: 4, height: 4, roomType: "bedroom" });
    const arrows: Arrow[] = [
      { id: "ext", level: 0, hostId: "a", kind: "exterior-main", side: 3, t: 0.5, dir: 1 },
      door("d", "a", 1, 0.96),
    ];
    const score = scoreCandidate([a, b], 1, arrows, false, ROOM_FACTS, []);
    // Two effects, both real, measured against the same plan with the
    // door taken away: adding it costs 0.6 of a hard problem (0.9 m of
    // wall required, 0.3 m present) and saves the whole 1 the bedroom
    // was costing as an unreachable room. A door on too little wall is
    // still better than no door -- it is just not free, which is exactly
    // what the search needs to be able to see.
    const without = scoreCandidate([a, b], 1, [arrows[0]], false, ROOM_FACTS, []);
    expect(score.hardProblems - without.hardProblems).toBeCloseTo(0.6 - 1, 3);
  });
});

describe("windowlessSleepingRooms: a room slept in needs a way out of it", () => {
  /** A bedroom completely boxed in by four neighbours: 3x3, with a room
   * hard against each of its four sides, each one overhanging it, so no
   * stretch of its outline faces outside at all. */
  const sealed = (): Box[] => [
    box({ id: "core", left: 3, top: 3, width: 3, height: 3, roomType: "bedroom" }),
    box({ id: "n", left: 2, top: 0, width: 5, height: 3, roomType: "storage" }),
    box({ id: "s", left: 2, top: 6, width: 5, height: 3, roomType: "storage" }),
    box({ id: "w", left: 0, top: 2, width: 3, height: 5, roomType: "storage" }),
    box({ id: "e", left: 6, top: 2, width: 3, height: 5, roomType: "storage" }),
  ];

  it("reports a sleeping room with every side covered by a neighbour", () => {
    const found = windowlessSleepingRooms(sealed(), 1, false, sleepingOf);
    expect(found).toHaveLength(1);
    expect(found[0].roomId).toBe("core");
    expect(found[0].exteriorM).toBeCloseTo(0, 6);
  });

  it("reports nothing once one side is opened up", () => {
    // The same plan with the neighbour to the east pulled clear: the
    // bedroom now has a 3 m wall facing outside, which is a window.
    const rooms = sealed().map((b) => (b.id === "e" ? { ...b, left: 12 } : b));
    expect(windowlessSleepingRooms(rooms, 1, false, sleepingOf)).toEqual([]);
  });

  it("reports nothing for a bathroom, hall, garage, or a room that borrows its light", () => {
    // The first group is legitimately internal and always has been. The
    // dining room and office are the deliberate narrowing: both are
    // habitable and both may lawfully take their light and air from an
    // adjoining room through a wide opening this tool cannot see, so
    // holding them to the escape-opening rule would flag an ordinary
    // arrangement as a defect. See habitability.ts's doc comment.
    for (const roomType of ["bathroom", "closet", "hallway", "garage_single", "storage", "laundry", "dining_room", "office"]) {
      const rooms = sealed().map((b) => (b.id === "core" ? { ...b, roomType } : b));
      expect(windowlessSleepingRooms(rooms, 1, false, sleepingOf)).toEqual([]);
    }
  });

  it("does not double-count a stretch of wall two neighbours both meet", () => {
    // Two 1.5 m neighbours meeting the bedroom's whole 3 m north wall,
    // and nothing anywhere else. Naive perimeter-minus-touches would
    // subtract 3 m twice and report 6 m of a 12 m perimeter gone; the
    // truth is 3, leaving 9 m outside-facing.
    const core = box({ id: "core", left: 3, top: 3, width: 3, height: 3, roomType: "bedroom" });
    const n1 = box({ id: "n1", left: 3, top: 0, width: 3, height: 3, roomType: "storage" });
    const n2 = box({ id: "n2", left: 3, top: 0, width: 3, height: 3, roomType: "storage" });
    expect(exteriorWallLength([core, n1, n2], 0, false, "core")).toBeCloseTo(9, 6);
    expect(windowlessSleepingRooms([core, n1, n2], 1, false, sleepingOf)).toEqual([]);
  });

  it("counts as a hard problem, one per sealed room", () => {
    const rooms = sealed();
    const withRule = scoreCandidate(rooms, 1, [], false, ROOM_FACTS, []);
    const opened = rooms.map((b) => (b.id === "e" ? { ...b, left: 12 } : b));
    const withoutIt = scoreCandidate(opened, 1, [], false, ROOM_FACTS, []);
    expect(withRule.findings.windowless).toHaveLength(1);
    expect(withoutIt.findings.windowless).toHaveLength(0);
    expect(withRule.hardProblems).toBe(withoutIt.hardProblems + 1);
  });
});

describe("singleAspectRooms: a room needs two sides facing out to breathe", () => {
  it("reports a room whose only exterior wall faces one way", () => {
    // A bedroom in the middle of a terrace: neighbours left, right and
    // behind, one wall to the street.
    const core = box({ id: "core", left: 3, top: 3, width: 3, height: 3, roomType: "bedroom" });
    const left = box({ id: "l", left: 0, top: 3, width: 3, height: 3, roomType: "bedroom" });
    const right = box({ id: "r", left: 6, top: 3, width: 3, height: 3, roomType: "bedroom" });
    const back = box({ id: "b", left: 3, top: 0, width: 3, height: 3, roomType: "storage" });
    const found = singleAspectRooms([core, left, right, back], 1, false, habitableOf);
    expect(found.map((f) => f.roomId)).toContain("core");
    expect(found.find((f) => f.roomId === "core")!.exteriorM).toBeCloseTo(3, 6);
  });

  it("reports nothing for a corner room facing two ways", () => {
    // The same room with the neighbour behind it removed: it now faces
    // south and north, which is a through draught.
    const core = box({ id: "core", left: 3, top: 3, width: 3, height: 3, roomType: "bedroom" });
    const left = box({ id: "l", left: 0, top: 3, width: 3, height: 3, roomType: "bedroom" });
    const right = box({ id: "r", left: 6, top: 3, width: 3, height: 3, roomType: "bedroom" });
    expect(singleAspectRooms([core, left, right], 1, false, habitableOf).map((f) => f.roomId)).not.toContain("core");
  });

  it("reports nothing for a hall, bathroom or garage in the same position", () => {
    for (const roomType of ["hallway", "bathroom", "garage_single", "storage"]) {
      const core = box({ id: "core", left: 3, top: 3, width: 3, height: 3, roomType });
      const left = box({ id: "l", left: 0, top: 3, width: 3, height: 3, roomType: "storage" });
      const right = box({ id: "r", left: 6, top: 3, width: 3, height: 3, roomType: "storage" });
      const back = box({ id: "b", left: 3, top: 0, width: 3, height: 3, roomType: "storage" });
      expect(singleAspectRooms([core, left, right, back], 1, false, habitableOf).map((f) => f.roomId)).not.toContain("core");
    }
  });

  it("is a soft recommendation, never a hard problem", () => {
    const core = box({ id: "core", left: 3, top: 3, width: 3, height: 3, roomType: "living_room" });
    const left = box({ id: "l", left: 0, top: 3, width: 3, height: 3, roomType: "storage" });
    const right = box({ id: "r", left: 6, top: 3, width: 3, height: 3, roomType: "storage" });
    const back = box({ id: "b", left: 3, top: 0, width: 3, height: 3, roomType: "storage" });
    const boxed = [core, left, right, back];
    const opened = boxed.map((b) => (b.id === "b" ? { ...b, top: -9 } : b));
    const closed = scoreCandidate(boxed, 1, [], false, ROOM_FACTS, []);
    const open = scoreCandidate(opened, 1, [], false, ROOM_FACTS, []);
    expect(closed.findings.singleAspect).toHaveLength(1);
    expect(open.findings.singleAspect).toHaveLength(0);
    expect(closed.hardProblems).toBe(open.hardProblems);
    expect(closed.softRecommendations).toBeGreaterThan(open.softRecommendations);
  });
});

describe("awkwardProportions: a room stretched too long stops being a room", () => {
  it("reports a room past three to one and not one under it", () => {
    const slot = box({ id: "slot", left: 0, top: 0, width: 12, height: 3, roomType: "bedroom" });
    const square = box({ id: "square", left: 0, top: 0, width: 4, height: 3, roomType: "bedroom" });
    expect(awkwardProportions([slot], 1, habitableOf).map((f) => f.roomId)).toEqual(["slot"]);
    expect(awkwardProportions([square], 1, habitableOf)).toEqual([]);
  });

  it("ignores rotation, which does not change a room's proportions", () => {
    const slot = box({ id: "slot", left: 0, top: 0, width: 12, height: 3, roomType: "bedroom", rotation: 37 });
    expect(awkwardProportions([slot], 1, habitableOf)).toHaveLength(1);
  });

  it("exempts corridors, whose job is to be long and narrow", () => {
    const hall = box({ id: "hall", left: 0, top: 0, width: 12, height: 1.2, roomType: "hallway", kind: "corridor" });
    expect(awkwardProportions([hall], 1, habitableOf)).toEqual([]);
  });

  it("skips a hand-drawn polygon, which has no meaningful long side", () => {
    const lShape = box({
      id: "l",
      left: 0,
      top: 0,
      width: 12,
      height: 3,
      roomType: "bedroom",
      shape: "polygon",
      points: [
        [0, 0],
        [1, 0],
        [1, 0.5],
        [0.4, 0.5],
        [0.4, 1],
        [0, 1],
      ],
    });
    expect(awkwardProportions([lShape], 1, habitableOf)).toEqual([]);
  });

  it("is soft and weighted by the overshoot: a slot counts for more than a slightly long room", () => {
    const slightly = box({ id: "r", left: 0, top: 0, width: 9.6, height: 3, roomType: "bedroom" });
    const slot = box({ id: "r", left: 0, top: 0, width: 24, height: 3, roomType: "bedroom" });
    const a = scoreCandidate([slightly], 1, [], false, ROOM_FACTS, []);
    const b = scoreCandidate([slot], 1, [], false, ROOM_FACTS, []);
    expect(a.hardProblems).toBe(b.hardProblems);
    expect(b.softRecommendations - a.softRecommendations).toBeCloseTo(8 - 3.2, 6);
  });
});

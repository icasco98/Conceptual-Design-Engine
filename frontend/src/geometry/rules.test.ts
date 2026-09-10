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

import { checkAdjacency, scoreCandidate, type RelationRow } from "./relationships";
import type { Arrow, Box } from "./types";
import { ROOM_FACTS } from "../rooms";

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

import { describe, expect, it } from "vitest";

import { generateLayout } from "./generate";
import { isOutsidePlot } from "./plot";
import { rectPolyOf } from "./poly";
import { boxesTrulyIntersect } from "./rect";
import { compareScores, scoreCandidate } from "./relationships";
import { liveBoxes } from "./snap";
import type { Box, Plot } from "./types";
import { SAMPLE_STOREYS, sampleArrows, sampleBoxes } from "../sample";
import { auxiliaryOf, circulationOf, passableOf, tierOf } from "../rooms";

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

function assertNoOverlapsOnLevel(boxes: Box[], level: number) {
  const live = liveBoxes(boxes, level);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      expect(boxesTrulyIntersect(live[i], live[j])).toBe(false);
    }
  }
}

describe("generateLayout: searches placement, never room program, never worse than the start", () => {
  it("never returns overlapping rooms on the level it searched, starting from the (non-overlapping) sample house", () => {
    const boxes = sampleBoxes();
    const arrows = sampleArrows(boxes);
    const result = generateLayout(
      boxes,
      0,
      SAMPLE_STOREYS,
      arrows,
      false,
      null,
      passableOf,
      tierOf,
      auxiliaryOf,
      circulationOf,
      undefined,
      { iterations: 150, seed: 1 },
    );
    assertNoOverlapsOnLevel(result, 0);
  });

  it("never scores worse than the arrangement it started from", () => {
    const boxes = sampleBoxes();
    const arrows = sampleArrows(boxes);
    const startScore = scoreCandidate(boxes, SAMPLE_STOREYS, arrows, false, passableOf, tierOf, auxiliaryOf, circulationOf);
    const result = generateLayout(
      boxes,
      0,
      SAMPLE_STOREYS,
      arrows,
      false,
      null,
      passableOf,
      tierOf,
      auxiliaryOf,
      circulationOf,
      undefined,
      { iterations: 150, seed: 2 },
    );
    const resultScore = scoreCandidate(result, SAMPLE_STOREYS, arrows, false, passableOf, tierOf, auxiliaryOf, circulationOf);
    expect(compareScores(resultScore, startScore)).toBeLessThanOrEqual(0);
    // The sample house already has zero hard problems -- the search must
    // never regress a known-good layout below that floor.
    expect(resultScore.hardProblems).toBe(0);
  });

  it("touches only the room program's geometry -- same ids and roomTypes come back, on the level it searched", () => {
    const boxes = sampleBoxes();
    const arrows = sampleArrows(boxes);
    const result = generateLayout(
      boxes,
      0,
      SAMPLE_STOREYS,
      arrows,
      false,
      null,
      passableOf,
      tierOf,
      auxiliaryOf,
      circulationOf,
      undefined,
      { iterations: 100, seed: 3 },
    );
    const beforeLevel0 = liveBoxes(boxes, 0).filter((b) => b.level === 0);
    const afterLevel0 = liveBoxes(result, 0).filter((b) => b.level === 0);
    expect(afterLevel0.map((b) => b.id).sort()).toEqual(beforeLevel0.map((b) => b.id).sort());
    const typeById = new Map(beforeLevel0.map((b) => [b.id, b.roomType]));
    for (const b of afterLevel0) expect(b.roomType).toBe(typeById.get(b.id));
    // Nothing off this level moved at all -- same object references.
    const untouchedBefore = boxes.filter((b) => b.level !== 0);
    const untouchedAfter = result.filter((b) => b.level !== 0);
    expect(untouchedAfter).toEqual(untouchedBefore);
  });

  it("is deterministic for a fixed seed", () => {
    const boxes = sampleBoxes();
    const arrows = sampleArrows(boxes);
    const run = () =>
      generateLayout(boxes, 0, SAMPLE_STOREYS, arrows, false, null, passableOf, tierOf, auxiliaryOf, circulationOf, undefined, {
        iterations: 120,
        seed: 42,
      });
    expect(run()).toEqual(run());
  });

  it("respects a given site boundary -- never returns a movable room outside it", () => {
    // A deliberately tight-but-sufficient plot: two 3x3 rooms with a
    // little slack either side, nothing like the sample house's own
    // scale, so the search is meaningfully constrained by the boundary
    // rather than never approaching it.
    const a = box({ id: "a", left: 0, top: 0, width: 3, height: 3, roomType: "bedroom" });
    const b = box({ id: "b", left: 3.5, top: 0, width: 3, height: 3, roomType: "bedroom" });
    const plot: Plot = { on: true, left: -1, top: -1, width: 10, depth: 6 };
    const boundary = rectPolyOf({ left: plot.left, top: plot.top, width: plot.width, height: plot.depth });
    const result = generateLayout(
      [a, b],
      0,
      1,
      [],
      false,
      boundary,
      passableOf,
      tierOf,
      auxiliaryOf,
      circulationOf,
      undefined,
      { iterations: 300, seed: 7 },
    );
    for (const room of liveBoxes(result, 0)) {
      expect(isOutsidePlot(room, plot)).toBe(false);
    }
  });

  it("leaves boxes unchanged when nothing is rooted on the requested level", () => {
    const boxes = sampleBoxes().filter((b) => b.level === 0);
    const result = generateLayout(boxes, 5, 6, [], false, null, passableOf, tierOf, auxiliaryOf, circulationOf);
    expect(result).toBe(boxes);
  });
});

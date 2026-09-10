import { describe, expect, it } from "vitest";

import { DEFAULT_SEARCH_CONFIG, generateLayout, type SearchConfig } from "./generate";
import { isOutsidePlot } from "./plot";
import { rectPolyOf } from "./poly";
import { boxesTrulyIntersect } from "./rect";
import { compareScores, scoreCandidate } from "./relationships";
import { liveBoxes } from "./snap";
import type { Box, Plot } from "./types";
import { SAMPLE_STOREYS, sampleArrows, sampleBoxes } from "../sample";
import { ROOM_FACTS } from "../rooms";

/** A config that only ever tries the `snap` move -- isolates it from the
 * other four move kinds so a test can attribute what happened to snap
 * alone, not to a lucky translate landing near the same spot. */
function snapOnlyConfig(): SearchConfig {
  return { ...DEFAULT_SEARCH_CONFIG, moveWeights: { translate: 0, resize: 0, rotate: 0, swap: 0, snap: 1 } };
}

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
      ROOM_FACTS,
      undefined,
      { iterations: 150, seed: 1 },
    );
    assertNoOverlapsOnLevel(result, 0);
  });

  it("never scores worse than the arrangement it started from", () => {
    const boxes = sampleBoxes();
    const arrows = sampleArrows(boxes);
    const startScore = scoreCandidate(boxes, SAMPLE_STOREYS, arrows, false, ROOM_FACTS);
    const result = generateLayout(
      boxes,
      0,
      SAMPLE_STOREYS,
      arrows,
      false,
      null,
      ROOM_FACTS,
      undefined,
      { iterations: 150, seed: 2 },
    );
    const resultScore = scoreCandidate(result, SAMPLE_STOREYS, arrows, false, ROOM_FACTS);
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
      ROOM_FACTS,
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
      generateLayout(boxes, 0, SAMPLE_STOREYS, arrows, false, null, ROOM_FACTS, undefined, {
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
      ROOM_FACTS,
      undefined,
      { iterations: 300, seed: 7 },
    );
    for (const room of liveBoxes(result, 0)) {
      expect(isOutsidePlot(room, plot)).toBe(false);
    }
  });

  it("leaves boxes unchanged when nothing is rooted on the requested level", () => {
    const boxes = sampleBoxes().filter((b) => b.level === 0);
    const result = generateLayout(boxes, 5, 6, [], false, null, ROOM_FACTS);
    expect(result).toBe(boxes);
  });
});

describe("generateLayout: the snap move (geometry/snap.ts's snapToNearbyNeighbors, wired in as a MoveKind)", () => {
  it("closes a sub-meter gap between two rooms to an exact touch", () => {
    // Kitchen/dining_room carries a `required` adjacency row
    // (relationships.ts), unmet while the two sit apart -- so once snap
    // closes the gap and suggestArrows can put a real door in the shared
    // wall, the arrangement scores strictly better and the search keeps
    // it as `best`, not merely as a rejected-or-accepted wobble of
    // `current`. isEntry on the kitchen only gives suggestArrows
    // somewhere to start its walk from; it isn't otherwise load-bearing.
    const a = box({ id: "a", left: 0, top: 0, width: 3.6, height: 4.2, roomType: "kitchen", isEntry: true });
    const b = box({ id: "b", left: 4.1, top: 0, width: 3.6, height: 4.2, roomType: "dining_room" }); // 0.5 m gap on x
    const boundary = rectPolyOf({ left: -5, top: -5, width: 30, height: 20 });
    const result = generateLayout([a, b], 0, 1, [], false, boundary, ROOM_FACTS, undefined, {
      iterations: 40,
      seed: 5,
      config: snapOnlyConfig(),
    });
    const ra = result.find((r) => r.id === "a")!;
    const rb = result.find((r) => r.id === "b")!;
    // Flush on x, still fully overlapping on y -- an exact touch, not
    // merely "closer than before".
    expect(Math.abs(rb.left - (ra.left + ra.width))).toBeLessThan(1e-6);
    expect(ra.top).toBe(0);
    expect(rb.top).toBe(0);
    assertNoOverlapsOnLevel(result, 0);
  });

  it("is rejected by the cheap filter when it would push a room outside the boundary", () => {
    // b sits just outside the plot already, 0.5 m from a's edge -- close
    // enough to qualify as a snap target. Whichever of the two the search
    // happens to move, the result lands further outside a boundary that
    // was never violated by leaving the pair alone, so the cheap filter
    // (`withinBoundary`) must refuse every proposal and the arrangement
    // never moves at all.
    const a = box({ id: "a", left: 0, top: 0, width: 3, height: 3 });
    const b = box({ id: "b", left: -2, top: 0, width: 1.5, height: 3 });
    const boundary = rectPolyOf({ left: 0, top: 0, width: 10, height: 10 });
    const boxes = [a, b];
    const result = generateLayout(boxes, 0, 1, [], false, boundary, ROOM_FACTS, undefined, {
      iterations: 30,
      seed: 9,
      config: snapOnlyConfig(),
    });
    // Never even accepted into the stochastic walk, let alone kept as
    // best: the starting arrangement comes back completely untouched.
    expect(result).toBe(boxes);
  });

  it("is rejected by the cheap filter when it would push a room into a third one snap's own gap check never saw", () => {
    // a and c already touch (0 gap), and so do c and b -- snap.ts's own
    // per-axis heuristic never looks for anything standing *between* the
    // room it's moving and the neighbour it picked, only at the direct
    // gap to that neighbour, so it proposes closing a's 0.5 m gap to b
    // straight through the room sitting in it. That is exactly the
    // "blind to the rule set, blind to everything but the one gap it's
    // closing" limitation the move is supposed to have -- catching this
    // is the cheap filter's job (`boxesTrulyIntersect` against every live
    // room, not just the one snap aimed at), not snap's own.
    const a = box({ id: "a", left: 0, top: 0, width: 2, height: 2 });
    const c = box({ id: "c", left: 2, top: 0.5, width: 0.5, height: 1 });
    const b = box({ id: "b", left: 2.5, top: 0, width: 2, height: 2 });
    const boundary = rectPolyOf({ left: -10, top: -10, width: 30, height: 20 });
    const boxes = [a, c, b];
    const result = generateLayout(boxes, 0, 1, [], false, boundary, ROOM_FACTS, undefined, {
      iterations: 40,
      seed: 13,
      config: snapOnlyConfig(),
    });
    expect(result).toBe(boxes);
  });
});

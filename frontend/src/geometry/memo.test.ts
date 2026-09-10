import { describe, expect, it } from "vitest";

import { displayShapes } from "./carve";
import { buildCirculationGraph, levelTouchData } from "./circulation";
import { buildCirculationGraphMemo, displayShapesForLevelMemo, levelTouchDataMemo } from "./memo";
import { liveBoxes } from "./snap";
import { SAMPLE_STOREYS, sampleArrows, sampleBoxes } from "../sample";

describe("memo.ts: caches the expensive derived geometry, keyed on boxes/arrows array identity", () => {
  it("displayShapesForLevelMemo matches the unmemoized call and is stable across repeat calls with the same boxes array", () => {
    const boxes = sampleBoxes();
    const direct = displayShapes(liveBoxes(boxes, 0), false);
    const first = displayShapesForLevelMemo(boxes, 0, false);
    const second = displayShapesForLevelMemo(boxes, 0, false);
    expect(first).toBe(second); // same array reference -- cache hit
    expect(first).toEqual(direct); // and it's the right answer

    const otherBoxes = sampleBoxes(); // a fresh array, same content
    const third = displayShapesForLevelMemo(otherBoxes, 0, false);
    expect(third).not.toBe(first); // different array identity -- no stale cross-candidate hit
    expect(third).toEqual(direct);
  });

  it("levelTouchDataMemo matches the unmemoized call and is stable across repeat calls, keyed per level/autoCarve", () => {
    const boxes = sampleBoxes();
    const direct = levelTouchData(boxes, 0, false);
    const first = levelTouchDataMemo(boxes, 0, false);
    const second = levelTouchDataMemo(boxes, 0, false);
    expect(first).toBe(second);
    expect(first).toEqual(direct);

    const otherLevel = levelTouchDataMemo(boxes, 1, false);
    expect(otherLevel).not.toBe(first);
  });

  it("buildCirculationGraphMemo matches the unmemoized call and is stable across repeat calls, keyed per boxes AND arrows identity", () => {
    const boxes = sampleBoxes();
    const arrows = sampleArrows(boxes);
    const direct = buildCirculationGraph(boxes, SAMPLE_STOREYS, arrows, false);
    const first = buildCirculationGraphMemo(boxes, SAMPLE_STOREYS, arrows, false);
    const second = buildCirculationGraphMemo(boxes, SAMPLE_STOREYS, arrows, false);
    expect(first).toBe(second);
    expect(first).toEqual(direct);

    const otherArrows = sampleArrows(boxes); // fresh array, same content
    const third = buildCirculationGraphMemo(boxes, SAMPLE_STOREYS, otherArrows, false);
    expect(third).not.toBe(first);
    expect(third).toEqual(direct);
  });
});

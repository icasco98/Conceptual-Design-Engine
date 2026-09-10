/**
 * Caches the expensive, purely-derived geometry (`carve.ts`'s
 * `displayShapes`, `circulation.ts`'s `levelTouchData`/
 * `buildCirculationGraph`) behind the same `boxes`/`arrows` arrays the
 * store already treats as immutable -- every store action replaces these
 * arrays wholesale (`set({ boxes: [...] })`), never mutates them in place,
 * so reference identity is a safe cache key here. A generator evaluating
 * many throwaway candidate `Box[]` arrays gets its own cache entries
 * reclaimed by garbage collection the moment each candidate array is
 * dropped -- no manual eviction needed.
 *
 * `carve.ts`/`circulation.ts` themselves are untouched and still directly
 * unit-tested; this file only wraps their entry points for the callers
 * (`relationships.ts`, `efficiency.ts`) that would otherwise rebuild the
 * same polygon-boolean/touch-graph work up to five times over one
 * `collectFindings` call.
 */
import { displayShapes, type DisplayShape } from "./carve";
import { buildCirculationGraph, levelTouchData, type CirculationGraph } from "./circulation";
import { liveBoxes } from "./snap";
import type { Arrow, Box } from "./types";

type LevelTouchData = ReturnType<typeof levelTouchData>;

function memoByBoxes<T>(cache: WeakMap<Box[], Map<string, T>>, boxes: Box[], key: string, compute: () => T): T {
  let byKey = cache.get(boxes);
  if (!byKey) {
    byKey = new Map();
    cache.set(boxes, byKey);
  }
  let hit = byKey.get(key);
  if (hit === undefined) {
    hit = compute();
    byKey.set(key, hit);
  }
  return hit;
}

const touchCache = new WeakMap<Box[], Map<string, LevelTouchData>>();

/** Memoized `circulation.ts`'s `levelTouchData` -- same signature, same
 * result, cached per `boxes` array per `level`/`autoCarve`. */
export function levelTouchDataMemo(boxes: Box[], level: number, autoCarve: boolean): LevelTouchData {
  return memoByBoxes(touchCache, boxes, `${level}:${autoCarve}`, () => levelTouchData(boxes, level, autoCarve));
}

const shapesCache = new WeakMap<Box[], Map<string, DisplayShape[]>>();

/** Memoized `displayShapes(liveBoxes(boxes, level), autoCarve)` -- the
 * same call `unnecessaryGaps`/`circulationRatio` already build by hand,
 * cached per `boxes` array per `level`/`autoCarve`. Order matches
 * `liveBoxes(boxes, level)` exactly (a deterministic filter), so callers
 * that also need the underlying `Box`s can keep computing `liveBoxes`
 * themselves and index it in step with this. */
export function displayShapesForLevelMemo(boxes: Box[], level: number, autoCarve: boolean): DisplayShape[] {
  return memoByBoxes(shapesCache, boxes, `${level}:${autoCarve}`, () => displayShapes(liveBoxes(boxes, level), autoCarve));
}

const graphCache = new WeakMap<Box[], WeakMap<Arrow[], Map<string, CirculationGraph>>>();

/** Memoized `circulation.ts`'s `buildCirculationGraph` -- same signature,
 * same result, cached per `boxes` array, per `arrows` array, per
 * `storeys`/`autoCarve`. This is the one that matters most:
 * `checkAdjacency`, `tierViolations`, `stairConnectionProblems`,
 * `corridorWaste` and `deadEndHallways` each ask for this same graph
 * independently within one `collectFindings` call. */
export function buildCirculationGraphMemo(boxes: Box[], storeys: number, arrows: Arrow[], autoCarve: boolean): CirculationGraph {
  let byArrows = graphCache.get(boxes);
  if (!byArrows) {
    byArrows = new WeakMap();
    graphCache.set(boxes, byArrows);
  }
  let byKey = byArrows.get(arrows);
  if (!byKey) {
    byKey = new Map();
    byArrows.set(arrows, byKey);
  }
  const key = `${storeys}:${autoCarve}`;
  let hit = byKey.get(key);
  if (!hit) {
    hit = buildCirculationGraph(boxes, storeys, arrows, autoCarve);
    byKey.set(key, hit);
  }
  return hit;
}

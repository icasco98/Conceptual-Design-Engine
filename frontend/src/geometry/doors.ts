/**
 * Door arrows: a breadth-first walk of the touching graph from the entry
 * (or, on an upper level, from the stair), one arrow per box crossing the
 * wall it was first reached through. The live equivalent of
 * src/layout.py's _build_circulation_edges.
 */
import { centerOf, rectOf } from "./rect";
import { DOOR_INSET_M, type Box, type Point, type Rect } from "./types";

export interface Touch {
  axis: "x" | "y";
  mid: Point;
}

/** If two rects share a boundary segment, which axis the shared wall is
 * perpendicular to and its midpoint. */
export function touchingEdge(a: Rect, b: Rect, tol: number): Touch | null {
  const ax1 = a.left + a.width;
  const ay1 = a.top + a.height;
  const bx1 = b.left + b.width;
  const by1 = b.top + b.height;
  if (Math.abs(ax1 - b.left) < tol || Math.abs(bx1 - a.left) < tol) {
    const yLo = Math.max(a.top, b.top);
    const yHi = Math.min(ay1, by1);
    if (yHi - yLo > tol) {
      const sharedX = Math.abs(ax1 - b.left) < tol ? b.left : a.left;
      return { axis: "x", mid: [sharedX, (yLo + yHi) / 2] };
    }
  }
  if (Math.abs(ay1 - b.top) < tol || Math.abs(by1 - a.top) < tol) {
    const xLo = Math.max(a.left, b.left);
    const xHi = Math.min(ax1, bx1);
    if (xHi - xLo > tol) {
      const sharedY = Math.abs(ay1 - b.top) < tol ? b.top : a.top;
      return { axis: "y", mid: [(xLo + xHi) / 2, sharedY] };
    }
  }
  return null;
}

export function perpendicularArrow(t: Touch, from: Point): [Point, Point] {
  const [mx, my] = t.mid;
  if (t.axis === "x") {
    const s = from[0] < mx ? -1 : 1;
    return [
      [mx + s * DOOR_INSET_M, my],
      [mx - s * DOOR_INSET_M, my],
    ];
  }
  const s = from[1] < my ? -1 : 1;
  return [
    [mx, my + s * DOOR_INSET_M],
    [mx, my - s * DOOR_INSET_M],
  ];
}

const TOUCH_TOL_M = 0.04;

export function doorArrows(live: Box[]): [Point, Point][] {
  let start = live.findIndex((b) => b.isEntry);
  if (start === -1) start = live.findIndex((b) => b.roomType === "stair");
  if (start === -1) return [];
  const rects = live.map(rectOf);
  const centers = rects.map(centerOf);
  const visited = new Array(live.length).fill(false);
  visited[start] = true;
  const queue = [start];
  const segs: [Point, Point][] = [];
  while (queue.length) {
    const cur = queue.shift()!;
    for (let j = 0; j < live.length; j++) {
      if (visited[j]) continue;
      const touch = touchingEdge(rects[cur], rects[j], TOUCH_TOL_M);
      if (!touch) continue;
      visited[j] = true;
      segs.push(perpendicularArrow(touch, centers[cur]));
      queue.push(j);
    }
  }
  return segs;
}

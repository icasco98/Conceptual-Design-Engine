/**
 * Shared walls between unrotated rectangles: which axis the wall is
 * perpendicular to, its midpoint and its own run -- the one primitive
 * `suggestArrows` (arrows.ts) and the circulation graph (circulation.ts)
 * both build on, so "touching" is decided in one place.
 */
import { rectOf } from "./rect";
import type { Box, Point, Rect } from "./types";

export interface Touch {
  axis: "x" | "y";
  mid: Point;
  /** The shared run of wall, along the axis it runs on (y for an "x"
   * wall, x for a "y" one) -- where along it a placed door actually
   * sits, not just whether one is near the midpoint. */
  lo: number;
  hi: number;
}

/** If two rects share a boundary segment, which axis the shared wall is
 * perpendicular to, its midpoint, and the run of the shared wall itself. */
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
      return { axis: "x", mid: [sharedX, (yLo + yHi) / 2], lo: yLo, hi: yHi };
    }
  }
  if (Math.abs(ay1 - b.top) < tol || Math.abs(by1 - a.top) < tol) {
    const xLo = Math.max(a.left, b.left);
    const xHi = Math.min(ax1, bx1);
    if (xHi - xLo > tol) {
      const sharedY = Math.abs(ay1 - b.top) < tol ? b.top : a.top;
      return { axis: "y", mid: [(xLo + xHi) / 2, sharedY], lo: xLo, hi: xHi };
    }
  }
  return null;
}

export interface TouchGraphEdge {
  to: string;
  touch: Touch;
}

/** Every pair of unrotated-rectangle zones in `boxes` that share a wall,
 * both directions. The one place that walks every pair looking for a
 * touch, so a second, slightly different copy of this loop does not
 * quietly grow somewhere else. */
export function buildTouchGraph(boxes: Box[], tol: number): Map<string, TouchGraphEdge[]> {
  const graph = new Map<string, TouchGraphEdge[]>();
  const plain = (b: Box) => b.shape === "rect" && !b.rotation;
  const live = boxes.filter(plain);
  const push = (from: Box, to: Box, touch: Touch) => {
    const list = graph.get(from.id) ?? [];
    list.push({ to: to.id, touch });
    graph.set(from.id, list);
  };
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const touch = touchingEdge(rectOf(live[i]), rectOf(live[j]), tol);
      if (!touch) continue;
      push(live[i], live[j], touch);
      push(live[j], live[i], touch);
    }
  }
  return graph;
}

/**
 * Shared walls between unrotated rectangles: which axis the wall is
 * perpendicular to and its midpoint. Used to suggest door arrows
 * (arrows.ts).
 */
import type { Point, Rect } from "./types";

interface Touch {
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

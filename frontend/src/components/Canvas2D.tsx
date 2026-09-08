/**
 * The plan: every zone on the current storey as a shape you can select,
 * drag, resize (corner handles for both sides at once, or a wall's own
 * handle for just that side), rotate (top handle) and delete, over a
 * blank sheet and, on an upper level, the dashed outline of the storey
 * below. The building outline recomputes from wherever the zones are.
 *
 * A resize always holds the corner or wall you are not touching exactly
 * where it is on the page, turned zone or not: dragging works in the
 * zone's own (rotated) axes, not the page's, so the far side never drifts.
 *
 * Door arrows are yours: each sits on a wall of its host zone, always
 * perpendicular to it. Drag one to slide it along the wall or onto
 * another wall of the same zone; the handles flip or delete it; the
 * Arrow tool puts a new interior one on the wall you click, and the two
 * door tools beside it place the building's exterior doors the same way
 * -- one main entrance at a time (also marking its host as the plan's
 * entry), any number of red side/service ones.
 *
 * A zone can also arrive from the schedule rather than being drawn: typed
 * there with a size and no position, it waits until "Place" arms the
 * `place` tool, which follows the pointer at its own size and drops where
 * you click, exactly as a freshly drawn zone would.
 *
 * Tools (the rail): Select rubber-bands a selection when you drag empty
 * sheet; Pan moves the view; Rectangle and Circle draw a new zone. With
 * several zones selected, dragging any of them moves them all, the rotate
 * handle turns them together about the group's centre, and × or Delete
 * takes them off the plan. That is not deleting them: a zone removed here
 * goes back to the schedule's "To place" list, sized and typed as it was,
 * ready to be dropped onto the plot again. Deleting it for good is done
 * from the schedule, once it is there.
 *
 * Zones overlap freely and nothing is ever pushed. The carve handle on a
 * selected zone (top-left) cuts every zone under it; pressing it again
 * releases the cut. A zone cut below its minimum is outlined in red.
 *
 * The plot is the one boundary. Switched off it is a faint rectangle for
 * reference, like the sheet, and a zone may be drawn anywhere. Switched
 * on it is a hard wall: every gesture here -- move, resize, rotate, draw
 * -- ends by asking geometry/plot.ts for the correction, so a zone stops
 * against the line while you are still dragging rather than being told
 * off after the fact. A selection is held in as one rigid body, so the
 * arrangement inside it never deforms against the wall, and a rotation is
 * never blocked: the zone turns to any angle and slides in far enough to
 * stay inside. A zone that was already outside when the boundary was
 * switched on is outlined, not moved.
 *
 * All geometry is in plan-frame meters (geometry/types.ts). The SVG's
 * inner group scales meters to pixels, so pointer positions are read back
 * in meters through its inverse screen matrix and nothing here ever
 * thinks in pixels. The camera (pan and zoom) is an outer group wrapping
 * that one, which is why dragging a zone still lands where the pointer is
 * at any zoom: the inverse screen matrix already carries the camera.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CategoryKey } from "../api/types";
import { arrowSegment } from "../geometry/arrows";
import { displayShapes } from "../geometry/carve";
import { footprintRings, ringsToPath } from "../geometry/footprint";
import { clampDrawnRect, clampGroup, isOutsidePlot, limitGrowth, plotBottom, plotRight } from "../geometry/plot";
import { anchorPoint, frameOf, polyArea, polyOfBox, resizedFromAnchor, toLocalVector } from "../geometry/poly";
import { isOpenToBelow, liveBoxes, snapToGrid, snapToNearbyNeighbors } from "../geometry/snap";
import { GRID_M, type Arrow, type Box, type Point, type Poly, type Rect } from "../geometry/types";
import { IconFit, IconMinus, IconPlus } from "./icons";
import { CATEGORY_WASH, INK, fillFor, zoneFill } from "../palette";
import { ZONE_LABELS } from "../rooms";
import { SHEET } from "../sample";
import { useStore } from "../state/store";

const PX = 26;
const MARGIN = 40;
const HEADROOM = 26;
/** Room below for the scale bar. */
const GUTTER_B = 86;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 12;
const HANDLE = 0.42;
/** A drawn zone smaller than this on either side is a slip, not a zone. */
const MIN_DRAW_M = 0.5;

type Corner = "nw" | "ne" | "sw" | "se";

type Gesture =
  | { kind: "move"; ids: string[]; startX: number; startY: number; snapshot: Box[] }
  | { kind: "resize"; id: string; corner: Corner; start: Rect; anchor: Point; sx: -1 | 1; sy: -1 | 1; startX: number; startY: number; snapshot: Box[] }
  | { kind: "resize-edge"; id: string; side: "n" | "s" | "e" | "w"; start: Rect; anchor: Point; sx: -1 | 0 | 1; sy: -1 | 0 | 1; startX: number; startY: number; snapshot: Box[] }
  | { kind: "vertex"; id: string; index: number; startX: number; startY: number; snapshot: Box[] }
  | { kind: "rotate"; ids: string[]; cx: number; cy: number; startAngle: number; snapshot: Box[] }
  | { kind: "marquee"; x0: number; y0: number; additive: boolean }
  | { kind: "draw"; shape: "rect" | "circle"; x0: number; y0: number }
  | { kind: "arrow"; id: string };

function pointsOf(poly: Poly): string {
  return poly.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(" ");
}

/** The next point the polygon tool places, grid-snapped and, with `ortho`
 * on, pinned square to the wall before it: whichever of x or y moved
 * further from `from` wins, the other is held at `from`'s value. */
function orthoPoint(from: Point, to: Point, ortho: boolean): Point {
  const x = snapToGrid(to[0]);
  const y = snapToGrid(to[1]);
  if (!ortho) return [x, y];
  return Math.abs(x - from[0]) >= Math.abs(y - from[1]) ? [x, from[1]] : [from[0], y];
}

/** Close enough to the polygon's first point that a click there finishes
 * the shape instead of adding another corner. */
const POLY_CLOSE_M = 0.35;

/** Keep the gesture even when the pointer leaves the element. A synthetic
 *  event has no pointer to capture, and that is not worth an exception. */
function capture(e: React.PointerEvent) {
  try {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  } catch {
    /* no live pointer */
  }
}

/** Strict: a marquee that only grazes a zone's edge does not take it. */
function rectsOverlapStrict(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/** The rectangle the live boxes occupy, in meters, or the sheet. */
function extentOf(boxes: Box[]): Rect {
  const live = boxes.filter((b) => !b.deleted);
  if (!live.length) return { left: 0, top: 0, width: SHEET.width, height: SHEET.depth };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of live) {
    for (const [x, y] of polyOfBox(b)) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
}

export function Canvas2D({ width: paneWidth }: { width?: number } = {}) {
  const boxes = useStore((s) => s.boxes);
  const recommended = useStore((s) => s.recommended);
  const level = useStore((s) => s.level);
  const selected = useStore((s) => s.selected);
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const select = useStore((s) => s.select);
  const selectMany = useStore((s) => s.selectMany);
  const addBox = useStore((s) => s.addBox);
  const addPolygonBox = useStore((s) => s.addPolygonBox);
  const setBoxes = useStore((s) => s.setBoxes);
  const commitBoxes = useStore((s) => s.commitBoxes);
  const unplaceBoxes = useStore((s) => s.unplaceBoxes);
  const carve = useStore((s) => s.carve);
  const release = useStore((s) => s.release);
  const convertToPolygon = useStore((s) => s.convertToPolygon);
  const showGrid = useStore((s) => s.showGrid);
  const showGhost = useStore((s) => s.showGhost);
  const showAbove = useStore((s) => s.showAbove);
  const autoCarve = useStore((s) => s.autoCarve);
  const storeys = useStore((s) => s.storeys);
  const remember = useStore((s) => s.remember);
  const plot = useStore((s) => s.plot);
  const arrows = useStore((s) => s.arrows);
  const selectedArrow = useStore((s) => s.selectedArrow);
  const selectArrow = useStore((s) => s.selectArrow);
  const addArrow = useStore((s) => s.addArrow);
  const moveArrow = useStore((s) => s.moveArrow);
  const flipArrow = useStore((s) => s.flipArrow);
  const deleteArrow = useStore((s) => s.deleteArrow);
  const placingId = useStore((s) => s.placingId);
  const placeBox = useStore((s) => s.placeBox);

  const gRef = useRef<SVGGElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [cam, setCam] = useState({ z: 1, x: 0, y: 0 });
  const pan = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const pending = useRef<{ x: number; y: number; shift: boolean } | null>(null);
  const frame = useRef(0);
  /** The marquee or the zone being drawn, in meters, while it is live.
   * Kept in a ref as well, because the gesture ends on a window event
   * whose closure may be a frame behind the state. */
  const [rubber, setRubberState] = useState<Rect | null>(null);
  const rubberRef = useRef<Rect | null>(null);
  const setRubber = useCallback((r: Rect | null) => {
    rubberRef.current = r;
    setRubberState(r);
  }, []);
  /** Where the pointer is while `place` is armed, in plan-frame meters:
   *  what the preview follows. Cleared whenever the tool stops being
   *  `place`, so a stale preview never survives a tool switch. */
  const [placeCursor, setPlaceCursor] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (tool !== "place") setPlaceCursor(null);
  }, [tool]);

  /** The polygon tool's corners placed so far, and where the next one
   *  would land -- both cleared whenever the tool stops being `polygon`. */
  const [polyDraft, setPolyDraft] = useState<Point[] | null>(null);
  const [polyCursor, setPolyCursor] = useState<Point | null>(null);
  useEffect(() => {
    if (tool !== "polygon") {
      setPolyDraft(null);
      setPolyCursor(null);
    }
  }, [tool]);
  const commitPolygon = useCallback(
    (points: Point[]) => {
      if (points.length >= 3) addPolygonBox(points);
      setPolyDraft(null);
      setPolyCursor(null);
      setTool("select");
    },
    [addPolygonBox, setTool],
  );
  const addPolyPoint = useCallback(
    (raw: Point, shift: boolean) => {
      setPolyDraft((prev) => {
        const draft = prev ?? [];
        const last = draft[draft.length - 1];
        let pt: Point = last ? orthoPoint(last, raw, shift) : [snapToGrid(raw[0]), snapToGrid(raw[1])];
        if (plot.on) {
          pt = [Math.min(Math.max(pt[0], plot.left), plotRight(plot)), Math.min(Math.max(pt[1], plot.top), plotBottom(plot))];
        }
        if (draft.length >= 3 && Math.hypot(pt[0] - draft[0][0], pt[1] - draft[0][1]) < POLY_CLOSE_M) {
          commitPolygon(draft);
          return draft;
        }
        return [...draft, pt];
      });
    },
    [commitPolygon, plot],
  );

  const live = useMemo(() => liveBoxes(boxes, level), [boxes, level]);
  const shapes = useMemo(() => displayShapes(live, autoCarve), [live, autoCarve]);
  const footprint = useMemo(() => ringsToPath(footprintRings(shapes.map((s) => s.page))), [shapes]);
  /** The building outline of the storey below, and of the one above, to
   *  line walls up against. Only the outlines: room names and walls from
   *  another floor were clutter. */
  const belowOutline = useMemo(() => {
    if (!showGhost || level === 0) return "";
    const under = displayShapes(liveBoxes(boxes, level - 1), autoCarve);
    return ringsToPath(footprintRings(under.map((s) => s.page)));
  }, [boxes, level, showGhost, autoCarve]);
  const aboveOutline = useMemo(() => {
    if (!showAbove || level >= storeys - 1) return "";
    const over = displayShapes(liveBoxes(boxes, level + 1), autoCarve);
    return ringsToPath(footprintRings(over.map((s) => s.page)));
  }, [boxes, level, showAbove, storeys, autoCarve]);
  const liveArrows = useMemo(() => {
    const here = new Map(live.filter((b) => !isOpenToBelow(b, level)).map((b) => [b.id, b]));
    return arrows.filter((a) => a.level === level && here.has(a.hostId)).map((a) => ({ arrow: a, host: here.get(a.hostId)! }));
  }, [arrows, live, level]);

  // The sheet is the drawing surface; it stretches to hold the plot so a
  // site larger than the default 24 x 18 m is never drawn off the edge.
  const width = Math.max(SHEET.width, plotRight(plot));
  const depth = Math.max(SHEET.depth, plotBottom(plot));
  const svgW = width * PX + MARGIN * 2;
  const svgH = depth * PX + MARGIN + HEADROOM + GUTTER_B;

  /** Pointer position in plan-frame meters. */
  const toMeters = useCallback((e: { clientX: number; clientY: number }) => {
    const g = gRef.current;
    if (!g) return { x: 0, y: 0 };
    const ctm = g.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  }, []);

  const mergeLevel = useCallback(
    (levelBoxes: Box[]) => {
      const byId = new Map(levelBoxes.map((b) => [b.id, b]));
      return boxes.map((b) => byId.get(b.id) ?? b);
    },
    [boxes],
  );
  const mergeRef = useRef(mergeLevel);
  mergeRef.current = mergeLevel;
  // The gesture runs in a requestAnimationFrame closure that outlives the
  // render it was made in; a ref keeps it reading the live boundary
  // rather than the one in force when the drag started.
  const plotRef = useRef(plot);
  plotRef.current = plot;

  // ---- gestures ---------------------------------------------------------

  const runFrame = useCallback(() => {
    frame.current = 0;
    const g = gesture.current;
    const p = pending.current;
    if (!g || !p) return;
    pending.current = null;

    if (g.kind === "move") {
      const restored = g.snapshot;
      const ids = new Set(g.ids);
      let dx = p.x - g.startX;
      let dy = p.y - g.startY;
      const lead = restored.find((b) => b.id === g.ids[0])!;
      if (!lead.rotation) {
        // Snap the lead box's corner to the grid; the rest ride along.
        dx = snapToGrid(lead.left + dx) - lead.left;
        dy = snapToGrid(lead.top + dy) - lead.top;
      }
      let moved = restored.map((b) => (ids.has(b.id) ? { ...b, left: b.left + dx, top: b.top + dy } : b));
      if (g.ids.length === 1 && !lead.rotation && lead.shape === "rect") {
        const me = moved.find((b) => b.id === lead.id)!;
        const snapped = snapToNearbyNeighbors(me, moved);
        moved = moved.map((b) => (b.id === me.id ? snapped : b));
      }
      // Last, because the gap snap above can pull a zone up to a metre and
      // would otherwise put it through the wall it was just held behind.
      setBoxes(mergeRef.current(clampGroup(moved, g.ids, plotRef.current)));
    } else if (g.kind === "resize") {
      const restored = g.snapshot;
      const box = restored.find((b) => b.id === g.id)!;
      // Rotation doesn't change mid-resize, so the box's own axes (and
      // the anchor corner's page position, captured at gesture start)
      // stay fixed for the whole gesture -- only the pointer's projection
      // onto them changes frame to frame.
      const [dx, dy] = toLocalVector(p.x - g.startX, p.y - g.startY, frameOf(box));
      // A turned zone doesn't snap to the world grid -- it isn't the
      // zone's own grid any more (moving one doesn't snap either).
      const snap = box.rotation ? (v: number) => v : snapToGrid;
      let w = g.start.width;
      let h = g.start.height;
      if (g.corner === "ne" || g.corner === "se") {
        const right = snap(g.start.left + g.start.width + dx);
        w = Math.max(box.minWidth, right - g.start.left);
      }
      if (g.corner === "nw" || g.corner === "sw") {
        const newLeft = snap(g.start.left + dx);
        w = Math.max(box.minWidth, g.start.left + g.start.width - newLeft);
      }
      if (g.corner === "se" || g.corner === "sw") {
        const bottom = snap(g.start.top + g.start.height + dy);
        h = Math.max(box.minHeight, bottom - g.start.top);
      }
      if (g.corner === "ne" || g.corner === "nw") {
        const newTop = snap(g.start.top + dy);
        h = Math.max(box.minHeight, g.start.top + g.start.height - newTop);
      }
      // Rebuilt from the fixed anchor corner rather than from left/top,
      // which is what kept the far corner of a turned zone from sliding.
      const resized = resizedFromAnchor(box, g.anchor, g.sx, g.sy, w, h);
      const next = limitGrowth(box, resized, plotRef.current, "inside");
      setBoxes(mergeRef.current(restored.map((b) => (b.id === g.id ? next : b))));
    } else if (g.kind === "resize-edge") {
      const restored = g.snapshot;
      const box = restored.find((b) => b.id === g.id)!;
      const [dx, dy] = toLocalVector(p.x - g.startX, p.y - g.startY, frameOf(box));
      const snap = box.rotation ? (v: number) => v : snapToGrid;
      let w = g.start.width;
      let h = g.start.height;
      if (g.side === "e") w = Math.max(box.minWidth, snap(g.start.left + g.start.width + dx) - g.start.left);
      if (g.side === "w") w = Math.max(box.minWidth, g.start.left + g.start.width - snap(g.start.left + dx));
      if (g.side === "s") h = Math.max(box.minHeight, snap(g.start.top + g.start.height + dy) - g.start.top);
      if (g.side === "n") h = Math.max(box.minHeight, g.start.top + g.start.height - snap(g.start.top + dy));
      const resized = resizedFromAnchor(box, g.anchor, g.sx, g.sy, w, h);
      const next = limitGrowth(box, resized, plotRef.current, "inside");
      setBoxes(mergeRef.current(restored.map((b) => (b.id === g.id ? next : b))));
    } else if (g.kind === "vertex") {
      const restored = g.snapshot;
      const box = restored.find((b) => b.id === g.id)!;
      if (!box.points) return;
      const [dx, dy] = toLocalVector(p.x - g.startX, p.y - g.startY, frameOf(box));
      const [ofx, ofy] = box.points[g.index];
      // Clamped to the box's own bounding box: reshaping doesn't grow it,
      // resizing (the handles around it) does.
      const fx = Math.min(1, Math.max(0, ofx + dx / box.width));
      const fy = Math.min(1, Math.max(0, ofy + dy / box.height));
      const points = box.points.map((pt, i): Point => (i === g.index ? [fx, fy] : pt));
      const next = { ...box, points };
      setBoxes(mergeRef.current(restored.map((b) => (b.id === g.id ? next : b))));
    } else if (g.kind === "rotate") {
      const restored = g.snapshot;
      const angle = (Math.atan2(p.y - g.cy, p.x - g.cx) * 180) / Math.PI + 90;
      // Free by default; Shift holds it to 15° steps.
      const step = p.shift ? 15 : 1;
      const delta = Math.round((angle - g.startAngle) / step) * step;
      const ids = new Set(g.ids);
      const rad = (delta * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const turned = restored.map((b) => {
        if (!ids.has(b.id)) return b;
        // Each zone turns by the delta, and the group orbits its centre.
        const cx = b.left + b.width / 2;
        const cy = b.top + b.height / 2;
        const ox = cx - g.cx;
        const oy = cy - g.cy;
        const ncx = g.cx + ox * cos - oy * sin;
        const ncy = g.cy + ox * sin + oy * cos;
        return { ...b, rotation: (((b.rotation + delta) % 360) + 360) % 360, left: ncx - b.width / 2, top: ncy - b.height / 2 };
      });
      // A turned rectangle reaches further than an upright one -- a 4 x 6 m
      // room at 45 degrees needs 7.1 m of width -- so a zone that fitted
      // snugly can stop fitting purely by turning. The turn is never
      // refused: it happens, and the zone slides in to make room for it.
      setBoxes(mergeRef.current(clampGroup(turned, g.ids, plotRef.current)));
    } else if (g.kind === "arrow") {
      moveArrow(g.id, [p.x, p.y]);
    } else if (g.kind === "marquee") {
      setRubber({ left: Math.min(g.x0, p.x), top: Math.min(g.y0, p.y), width: Math.abs(p.x - g.x0), height: Math.abs(p.y - g.y0) });
    } else if (g.kind === "draw") {
      const x1 = snapToGrid(p.x);
      const y1 = snapToGrid(p.y);
      let w = Math.abs(x1 - g.x0);
      let h = Math.abs(y1 - g.y0);
      // Shift, or the circle tool, holds the shape square.
      if (p.shift || g.shape === "circle") w = h = Math.max(w, h);
      const left = x1 < g.x0 ? g.x0 - w : g.x0;
      const top = y1 < g.y0 ? g.y0 - h : g.y0;
      setRubber(clampDrawnRect({ left, top, width: w, height: h }, plotRef.current));
    }
  }, [moveArrow, setBoxes, setRubber]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!gesture.current) return;
      pending.current = { ...toMeters(e), shift: e.shiftKey };
      if (!frame.current) frame.current = requestAnimationFrame(runFrame);
      e.preventDefault();
    },
    [runFrame, toMeters],
  );

  const endGesture = useCallback(() => {
    if (frame.current) {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      runFrame();
    }
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.kind === "marquee") {
      const r = rubberRef.current;
      setRubber(null);
      if (r && (r.width > 0.1 || r.height > 0.1)) {
        const state = useStore.getState();
        const hit = liveBoxes(state.boxes, state.level)
          .filter((b) => {
            const poly = polyOfBox(b);
            const xs = poly.map((q) => q[0]);
            const ys = poly.map((q) => q[1]);
            const bb = { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
            return rectsOverlapStrict(bb, r);
          })
          .map((b) => b.id);
        selectMany(hit, g.additive);
      } else if (!g.additive) {
        select(null);
      }
      return;
    }
    if (g.kind === "draw") {
      const r = rubberRef.current;
      setRubber(null);
      if (r && r.width >= MIN_DRAW_M && r.height >= MIN_DRAW_M) {
        addBox(g.shape, r.left, r.top, r.width, r.height);
      }
      setTool("select");
      return;
    }
    if (g.kind === "arrow") return;
    commitBoxes(useStore.getState().boxes);
  }, [addBox, commitBoxes, runFrame, select, selectMany, setRubber, setTool]);

  useEffect(() => {
    const up = () => endGesture();
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [endGesture]);

  // Delete removes the selection; Escape clears it and returns to Select.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      const state = useStore.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) state.redo();
        else state.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        state.redo();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && state.selectedArrow) {
        e.preventDefault();
        deleteArrow(state.selectedArrow);
      } else if ((e.key === "Delete" || e.key === "Backspace") && state.selected.length) {
        e.preventDefault();
        state.unplaceBoxes(state.selected);
      } else if (e.key === "Enter" && tool === "polygon" && polyDraft && polyDraft.length >= 3) {
        e.preventDefault();
        commitPolygon(polyDraft);
      } else if (e.key === "Escape") {
        select(null);
        selectArrow(null);
        setTool("select");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commitPolygon, deleteArrow, polyDraft, select, selectArrow, setTool, tool]);

  const startMove = (e: React.PointerEvent, b: Box) => {
    if (tool === "rect" || tool === "circle" || tool === "place") return; // drawing/placing starts on the sheet below
    e.stopPropagation();
    e.preventDefault();
    if (tool === "arrow" || tool === "arrow-main" || tool === "arrow-side") {
      // A zone open to below has no floor on this storey, so no door.
      if (!isOpenToBelow(b, level)) {
        const p = toMeters(e);
        const kind = tool === "arrow-main" ? "exterior-main" : tool === "arrow-side" ? "exterior-side" : "interior";
        addArrow(b.id, [p.x, p.y], kind);
      }
      setTool("select");
      return;
    }
    const inGroup = selected.includes(b.id) && selected.length > 1;
    if (!inGroup) select(b.id, e.shiftKey);
    // Shift-click on a grouped box toggles it out rather than dragging.
    if (inGroup && e.shiftKey) {
      select(b.id, true);
      return;
    }
    const p = toMeters(e);
    // The grabbed box leads: its corner is what snaps to the grid.
    const ids = inGroup ? [b.id, ...selected.filter((id) => id !== b.id)] : [b.id];
    remember();
    gesture.current = { kind: "move", ids, startX: p.x, startY: p.y, snapshot: live };
    capture(e);
  };

  const startResize = (e: React.PointerEvent, b: Box) => (corner: Corner) => {
    e.stopPropagation();
    e.preventDefault();
    const p = toMeters(e);
    remember();
    // The corner you are not dragging: what must hold still on the page,
    // not just keep the same left/top numbers (geometry/poly.ts).
    const sx: -1 | 1 = corner.includes("w") ? 1 : -1;
    const sy: -1 | 1 = corner.includes("n") ? 1 : -1;
    gesture.current = {
      kind: "resize",
      id: b.id,
      corner,
      start: { left: b.left, top: b.top, width: b.width, height: b.height },
      anchor: anchorPoint(b, sx, sy),
      sx,
      sy,
      startX: p.x,
      startY: p.y,
      snapshot: live,
    };
    capture(e);
  };

  const startEdgeResize = (e: React.PointerEvent, b: Box) => (side: "n" | "s" | "e" | "w") => {
    e.stopPropagation();
    e.preventDefault();
    const p = toMeters(e);
    remember();
    // The opposite wall is what stays put.
    const sx: -1 | 0 | 1 = side === "e" ? -1 : side === "w" ? 1 : 0;
    const sy: -1 | 0 | 1 = side === "s" ? -1 : side === "n" ? 1 : 0;
    gesture.current = {
      kind: "resize-edge",
      id: b.id,
      side,
      start: { left: b.left, top: b.top, width: b.width, height: b.height },
      anchor: anchorPoint(b, sx, sy),
      sx,
      sy,
      startX: p.x,
      startY: p.y,
      snapshot: live,
    };
    capture(e);
  };

  /** Drag one corner of a polygon zone's own outline: the shape reshapes
   * within its current bounding box (no other vertex moves, and the box
   * itself doesn't grow) -- resize the box first, with the handles above,
   * if a corner needs to go further than that. */
  const startVertexDrag = (e: React.PointerEvent, b: Box, index: number) => {
    e.stopPropagation();
    e.preventDefault();
    const p = toMeters(e);
    remember();
    gesture.current = { kind: "vertex", id: b.id, index, startX: p.x, startY: p.y, snapshot: live };
    capture(e);
  };

  const startRotate = (e: React.PointerEvent, b: Box) => {
    e.stopPropagation();
    e.preventDefault();
    const ids = selected.includes(b.id) && selected.length > 1 ? [...selected] : [b.id];
    // A single zone turns about its own centre; a group about the centre
    // of the group's bounding box.
    const members = live.filter((x) => ids.includes(x.id));
    const xs = members.flatMap((x) => [x.left, x.left + x.width]);
    const ys = members.flatMap((x) => [x.top, x.top + x.height]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const p = toMeters(e);
    const startAngle = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90;
    remember();
    gesture.current = { kind: "rotate", ids, cx, cy, startAngle, snapshot: live };
    capture(e);
  };

  const onDelete = (e: React.PointerEvent, b: Box) => {
    e.stopPropagation();
    e.preventDefault();
    unplaceBoxes(selected.includes(b.id) && selected.length > 1 ? selected : [b.id]);
  };

  const carvesSomething = (b: Box) => live.some((o) => o.carvedBy.includes(b.id));

  const startArrowDrag = (e: React.PointerEvent, a: Arrow) => {
    e.stopPropagation();
    e.preventDefault();
    selectArrow(a.id);
    remember();
    gesture.current = { kind: "arrow", id: a.id };
    capture(e);
  };
  const onFlipArrow = (e: React.PointerEvent, a: Arrow) => {
    e.stopPropagation();
    e.preventDefault();
    flipArrow(a.id);
  };
  const onDeleteArrow = (e: React.PointerEvent, a: Arrow) => {
    e.stopPropagation();
    e.preventDefault();
    deleteArrow(a.id);
  };

  /** Carve with this zone, or release its cuts if it already carves. */
  const onCarve = (e: React.PointerEvent, b: Box) => {
    e.stopPropagation();
    e.preventDefault();
    if (carvesSomething(b)) release(b.id);
    else carve(b.id);
  };

  const onConvertToPolygon = (e: React.PointerEvent, b: Box) => {
    e.stopPropagation();
    e.preventDefault();
    convertToPolygon(b.id);
  };

  // ---- the sheet: pan, marquee, draw ------------------------------------

  /** Pointer position in the SVG's own viewBox units, before the camera. */
  const toViewBox = useCallback((e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const p = toViewBox(e);
      setCam((c) => {
        const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, c.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        // Hold the point under the pointer still: it is at (p - offset) / z
        // in camera space before and after, so the offset absorbs the change.
        return { z, x: p.x - ((p.x - c.x) / c.z) * z, y: p.y - ((p.y - c.y) / c.z) * z };
      });
    },
    [toViewBox],
  );

  const onSheetDown = useCallback(
    (e: React.PointerEvent) => {
      const drawing = tool === "rect" || tool === "circle";
      const placing = tool === "place" && !!placingId;
      const polygoning = tool === "polygon";
      // Only the background, unless drawing, placing or polygoning: a new
      // zone, or one dropped from the schedule, may land over an existing
      // one, since zones are allowed to overlap.
      if (!drawing && !placing && !polygoning && e.target !== e.currentTarget) return;
      const middle = e.button === 1;
      if (tool === "pan" || middle) {
        e.currentTarget.setPointerCapture(e.pointerId);
        pan.current = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
        setPanning(true);
        return;
      }
      const p = toMeters(e);
      if (placing) {
        const box = boxes.find((b) => b.id === placingId);
        if (box) placeBox(placingId, snapToGrid(p.x - box.width / 2), snapToGrid(p.y - box.height / 2));
        return;
      }
      if (polygoning) {
        addPolyPoint([p.x, p.y], e.shiftKey);
        return;
      }
      if (drawing) {
        gesture.current = { kind: "draw", shape: tool, x0: snapToGrid(p.x), y0: snapToGrid(p.y) };
        setRubber({ left: snapToGrid(p.x), top: snapToGrid(p.y), width: 0, height: 0 });
      } else {
        selectArrow(null);
        gesture.current = { kind: "marquee", x0: p.x, y0: p.y, additive: e.shiftKey };
        setRubber(null);
      }
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [addPolyPoint, boxes, cam.x, cam.y, placeBox, placingId, selectArrow, setRubber, toMeters, tool],
  );

  const onPanMove = useCallback((e: React.PointerEvent) => {
    const p = pan.current;
    if (!p) return;
    const svg = svgRef.current;
    const rect = svg?.getBoundingClientRect();
    if (!rect) return;
    // Screen pixels to viewBox units: the SVG scales to fit its box.
    const k = svgW / rect.width;
    setCam((c) => ({ ...c, x: p.cx + (e.clientX - p.x) * k, y: p.cy + (e.clientY - p.y) * k }));
  }, [svgW]);

  const onPanUp = useCallback(() => {
    if (!pan.current) return;
    pan.current = null;
    setPanning(false);
  }, []);

  /** Frame the building with some air around it. The viewBox is always
   * fully visible (xMidYMid meet), so centring on the viewBox's middle
   * centres it on screen whatever the pane's shape. */
  const fitTo = useCallback((r: Rect) => {
    const w = Math.max(r.width, 4) + 3;
    const h = Math.max(r.height, 4) + 3;
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(svgW / (w * PX), svgH / (h * PX))));
    const cx = MARGIN + (r.left + r.width / 2) * PX;
    const cy = MARGIN + HEADROOM + (r.top + r.height / 2) * PX;
    setCam({ z, x: svgW / 2 - z * cx, y: svgH / 2 - z * cy });
  }, [svgH, svgW]);
  const fit = useCallback(() => fitTo(extentOf(useStore.getState().boxes)), [fitTo]);

  // Frame whatever was just loaded -- the sample, or a saved layout.
  useEffect(() => {
    fitTo(extentOf(recommended));
  }, [recommended, fitTo]);

  const scaleBarM = 5;
  const cursor = panning ? "grabbing" : tool === "pan" ? "grab" : tool === "select" ? "default" : "crosshair";

  return (
    <div className={`plan-pane tool-${tool}`} style={paneWidth ? { cursor, flex: "none", width: paneWidth } : { cursor }}>
      <div className="pane-tag label">Plan</div>
      <div className="legend" style={{ position: "absolute", top: 12, right: 16, maxWidth: 300, justifyContent: "flex-end" }}>
        {(["category_a", "category_b", "category_c"] as CategoryKey[]).map((k) => (
          <span key={k} className="legend-item">
            <i style={{ background: zoneFill(k) }} /> {ZONE_LABELS[k]}
          </span>
        ))}
        <span className="legend-item">
          <i className="legend-hall" /> Hallway
        </span>
        <span className="legend-item">
          <i style={{ background: fillFor("stair", "room") }} /> Stair
        </span>
        <span className="legend-item">
          <i className="legend-entry" /> Entry
        </span>
        <span className="legend-item">→ Door</span>
        <span className="legend-item" style={{ color: "#111" }}>⇥ Main entrance</span>
        <span className="legend-item" style={{ color: "#b3392b" }}>⇥ Side entrance</span>
      </div>
      {(tool === "rect" || tool === "circle") && (
        <div className="pane-hint">
          Drag on the sheet to draw a {tool === "rect" ? "rectangle (hold Shift for a square)" : "circle"}. Esc to cancel.
        </div>
      )}
      {tool === "polygon" && (
        <div className="pane-hint">
          Click to place each corner (hold Shift to keep that wall square to the last one, for a rectilinear shape). Click the
          first corner again, or press Enter, to close it. Esc to cancel.
        </div>
      )}
      {tool === "arrow" && <div className="pane-hint">Click a zone's wall to put a door arrow on it. Esc to cancel.</div>}
      {tool === "arrow-main" && <div className="pane-hint">Click a zone's exterior wall to place the main entrance. Esc to cancel.</div>}
      {tool === "arrow-side" && <div className="pane-hint">Click a zone's exterior wall to place a side or service entrance. Esc to cancel.</div>}
      {tool === "place" && placingId && (
        <div className="pane-hint">Click on the sheet to place "{boxes.find((b) => b.id === placingId)?.name ?? "the zone"}". Esc to cancel.</div>
      )}
      <svg
        ref={svgRef}
        className="plan-svg"
        viewBox={`0 0 ${svgW} ${svgH}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerMove={(e) => {
          onPointerMove(e);
          onPanMove(e);
          if (tool === "place") {
            const p = toMeters(e);
            setPlaceCursor({ x: snapToGrid(p.x), y: snapToGrid(p.y) });
          }
          if (tool === "polygon" && polyDraft && polyDraft.length) {
            const p = toMeters(e);
            setPolyCursor(orthoPoint(polyDraft[polyDraft.length - 1], [p.x, p.y], e.shiftKey));
          }
        }}
        onPointerDown={onSheetDown}
        onPointerUp={onPanUp}
        onPointerLeave={onPanUp}
        onWheel={onWheel}
      >
        <defs>
          <pattern id="grid" width={GRID_M} height={GRID_M} patternUnits="userSpaceOnUse">
            <path d={`M ${GRID_M} 0 L 0 0 0 ${GRID_M}`} fill="none" stroke="#000" strokeOpacity="0.08" strokeWidth={0.02} />
          </pattern>
          <pattern id="hatch" width={0.5} height={0.5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2={0.5} stroke={INK.site} strokeWidth={0.09} />
          </pattern>
          <marker id="door-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse" markerUnits="strokeWidth">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#1a1a1a" fillOpacity="0.6" />
          </marker>
          <marker id="door-arrow-main" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse" markerUnits="strokeWidth">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#111111" />
          </marker>
          <marker id="door-arrow-side" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse" markerUnits="strokeWidth">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#b3392b" />
          </marker>
        </defs>
        <g transform={`translate(${cam.x} ${cam.y}) scale(${cam.z})`} pointerEvents="none">
        <g ref={gRef} transform={`translate(${MARGIN} ${MARGIN + HEADROOM}) scale(${PX})`}>
          {/* the sheet: a reference area, never a boundary */}
          <rect x={0} y={0} width={width} height={depth} fill={INK.sheet} stroke={INK.site} strokeWidth={0.04} strokeDasharray="0.3 0.3" />
          {showGrid && <rect x={0} y={0} width={width} height={depth} fill="url(#grid)" />}
          {/* the plot. Switched off it is a dashed hint like the sheet;
              switched on the ground beyond it is greyed and its line is
              solid and heavy, so the wall is visible before you meet it. */}
          {plot.on && (
            <path
              className="plot-beyond"
              fillRule="evenodd"
              d={`M0 0H${width}V${depth}H0Z M${plot.left} ${plot.top}H${plotRight(plot)}V${plotBottom(plot)}H${plot.left}Z`}
              fill={INK.site}
              fillOpacity={0.34}
            />
          )}
          <rect
            className={`plot ${plot.on ? "on" : ""}`}
            x={plot.left}
            y={plot.top}
            width={plot.width}
            height={plot.depth}
            fill="none"
            stroke={plot.on ? INK.plot : INK.site}
            strokeWidth={plot.on ? 0.16 : 0.05}
            strokeDasharray={plot.on ? undefined : "0.5 0.35"}
          />
          {/* the outlines of the storeys below and above */}
          {belowOutline && (
            <path d={belowOutline} className="ghost below" fill="none" stroke="#8a8f8b" strokeWidth={0.07} strokeDasharray="0.45 0.25" strokeLinejoin="round" />
          )}
          {aboveOutline && (
            <path d={aboveOutline} className="ghost above" fill="none" stroke="#7e86a6" strokeWidth={0.07} strokeDasharray="0.12 0.2" strokeLinejoin="round" />
          )}
          {/* footprint */}
          <path d={footprint} fill="none" stroke={INK.footprint} strokeWidth={0.2} strokeLinejoin="round" />
          {/* zones */}
          {live.map((b) => {
            const shape = shapes.find((s) => s.id === b.id);
            const poly = shape?.local ?? [
              [b.left, b.top],
              [b.left + b.width, b.top],
              [b.left + b.width, b.top + b.height],
              [b.left, b.top + b.height],
            ];
            const cx = b.left + b.width / 2;
            const cy = b.top + b.height / 2;
            const isSel = selected.includes(b.id);
            const solo = isSel && selected.length === 1;
            const flagged = shape?.flagged ?? false;
            // Outside the plot: only possible for a zone that was already
            // there when the boundary was switched on, or one too big to
            // fit inside it. Marked, never dragged in (geometry/plot.ts).
            const outside = isOutsidePlot(b, plot);
            const carving = carvesSomething(b);
            // Above its own floor a tall zone is the void it leaves, not
            // a room: crossed through, named, and no door leads into it.
            const openBelow = isOpenToBelow(b, level);
            const fill = fillFor(b.roomType, b.kind);
            const spans = b.levelTo > b.level;
            // Labels shrink to fit narrow zones rather than spilling over
            // the neighbour; below ~0.28 m they turn vertical instead.
            const labelText = b.name + (spans ? " ⇅" : "");
            let fontSize = Math.min(0.5, b.width / (labelText.length * 0.6));
            const vertical = fontSize < 0.28 && b.height > b.width * 1.6;
            // The area only fits under the name when the zone has room for it.
            const showArea = !vertical && b.kind === "room" && b.height > 2.2 && b.width > 2.2;
            if (vertical) fontSize = Math.min(0.5, b.height / (labelText.length * 0.6));
            fontSize = Math.max(0.22, fontSize);
            return (
              <g
                key={b.id}
                className={`box ${b.kind} ${b.isEntry ? "entry" : ""} ${isSel ? "selected" : ""} ${shape?.carved ? "carved" : ""} ${flagged ? "flagged" : ""} ${outside ? "outside-plot" : ""} ${openBelow ? "open-below" : ""}`}
                transform={`rotate(${b.rotation} ${cx} ${cy})`}
                pointerEvents="all"
                onPointerDown={(e) => startMove(e, b)}
              >
                <polygon
                  points={pointsOf(poly)}
                  fill={b.kind === "corridor" ? "url(#hatch)" : fill}
                  fillOpacity={b.kind === "corridor" ? 1 : isSel ? CATEGORY_WASH * 2 : CATEGORY_WASH}
                  stroke={flagged || outside ? INK.flag : b.isEntry || isSel ? "#0b0b0b" : INK.room}
                  strokeWidth={flagged || outside || b.isEntry || isSel ? 0.12 : 0.05}
                  // A carve flag is solid; outside the plot is dashed, so
                  // the two red outlines never say the same thing.
                  strokeDasharray={outside ? "0.5 0.25" : b.isEntry ? "0.35 0.2" : undefined}
                  strokeLinejoin="round"
                />
                {b.kind === "corridor" && (
                  <polygon points={pointsOf(poly)} fill={INK.sheet} fillOpacity={0.55} stroke="none" />
                )}
                <text
                  x={cx}
                  y={vertical || !showArea ? cy : cy - 0.08}
                  className="room-label"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  style={{ fontSize: `${fontSize}px` }}
                  transform={vertical ? `rotate(-90 ${cx} ${cy})` : undefined}
                >
                  {labelText}
                </text>
                {showArea && !openBelow && (
                  <text x={cx} y={cy + 0.82} className="area-label" textAnchor="middle" style={{ fontSize: 0.44 }}>
                    {(shape ? polyArea(shape.page) : b.width * b.height).toFixed(1)} m²
                  </text>
                )}
                {openBelow && (
                  <>
                    <line x1={b.left} y1={b.top} x2={b.left + b.width} y2={b.top + b.height} className="void-cross" />
                    <line x1={b.left + b.width} y1={b.top} x2={b.left} y2={b.top + b.height} className="void-cross" />
                    {showArea && (
                      <text x={cx} y={cy + 0.82} className="void-label" textAnchor="middle" style={{ fontSize: 0.4 }}>
                        Open to below
                      </text>
                    )}
                  </>
                )}
                {solo &&
                  (["nw", "ne", "sw", "se"] as Corner[]).map((c) => (
                    <rect
                      key={c}
                      className={`handle resize ${c}`}
                      x={(c.includes("e") ? b.left + b.width : b.left) - HANDLE / 2}
                      y={(c.includes("s") ? b.top + b.height : b.top) - HANDLE / 2}
                      width={HANDLE}
                      height={HANDLE}
                      onPointerDown={(e) => startResize(e, b)(c)}
                    />
                  ))}
                {/* one grab bar per wall, along its middle third: drag a
                    wall to move only that side, the opposite one held put */}
                {solo &&
                  (["n", "s", "e", "w"] as const).map((side) => {
                    const horiz = side === "n" || side === "s";
                    const thickness = HANDLE * 0.6;
                    const length = Math.max(0.3, (horiz ? b.width : b.height) - HANDLE * 1.6);
                    const x = side === "e" ? b.left + b.width - thickness / 2 : side === "w" ? b.left - thickness / 2 : b.left + (b.width - length) / 2;
                    const y = side === "s" ? b.top + b.height - thickness / 2 : side === "n" ? b.top - thickness / 2 : b.top + (b.height - length) / 2;
                    return (
                      <rect
                        key={side}
                        className={`handle resize-edge ${side}`}
                        x={x}
                        y={y}
                        width={horiz ? length : thickness}
                        height={horiz ? thickness : length}
                        onPointerDown={(e) => startEdgeResize(e, b)(side)}
                      />
                    );
                  })}
                {/* a polygon zone's own corners, reshaped one at a time
                    within the bounding box the handles above resize */}
                {solo &&
                  b.shape === "polygon" &&
                  b.points?.map((pt, i) => (
                    <circle
                      key={i}
                      className="handle vertex"
                      cx={b.left + pt[0] * b.width}
                      cy={b.top + pt[1] * b.height}
                      r={HANDLE * 0.4}
                      onPointerDown={(e) => startVertexDrag(e, b, i)}
                    />
                  ))}
                {isSel && (
                  <>
                    <line x1={cx} y1={b.top} x2={cx} y2={b.top - 0.9} stroke="#0b0b0b" strokeWidth={0.04} />
                    <circle className="handle rotate" cx={cx} cy={b.top - 1.1} r={HANDLE / 2} onPointerDown={(e) => startRotate(e, b)} />
                    <text x={cx} y={b.top - 1.1} className="handle-glyph" textAnchor="middle" dominantBaseline="middle">
                      ↻
                    </text>
                    <circle className="handle delete" cx={b.left + b.width + 0.55} cy={b.top - 0.55} r={HANDLE / 2} onPointerDown={(e) => onDelete(e, b)}>
                      <title>Take off the plan (stays in the schedule, ready to place again)</title>
                    </circle>
                    <text x={b.left + b.width + 0.55} y={b.top - 0.55} className="handle-glyph" textAnchor="middle" dominantBaseline="middle">
                      ×
                    </text>
                    {solo && (
                      <>
                        <title>{carving ? "Release: stop carving the zones under this one" : "Carve the zones under this one"}</title>
                        <circle
                          className={`handle carve ${carving ? "on" : ""}`}
                          cx={b.left - 0.55}
                          cy={b.top - 0.55}
                          r={HANDLE / 2}
                          onPointerDown={(e) => onCarve(e, b)}
                        />
                        <text x={b.left - 0.55} y={b.top - 0.55} className="handle-glyph" textAnchor="middle" dominantBaseline="middle">
                          {carving ? "⊟" : "⊠"}
                        </text>
                      </>
                    )}
                    {solo && b.shape !== "polygon" && (
                      <>
                        <circle
                          className="handle to-polygon"
                          cx={b.left - 0.55}
                          cy={b.top + b.height + 0.55}
                          r={HANDLE / 2}
                          onPointerDown={(e) => onConvertToPolygon(e, b)}
                        >
                          <title>Convert to a polygon: freezes this outline (as carved) so each corner can be dragged on its own</title>
                        </circle>
                        <text x={b.left - 0.55} y={b.top + b.height + 0.55} className="handle-glyph" textAnchor="middle" dominantBaseline="middle">
                          ⬠
                        </text>
                      </>
                    )}
                  </>
                )}
              </g>
            );
          })}
          {/* door arrows: on their host's wall, perpendicular to it */}
          {liveArrows.map(({ arrow, host }) => {
            const [a, c] = arrowSegment(host, arrow);
            const sel = arrow.id === selectedArrow;
            const kind = arrow.kind ?? "interior";
            const mx = (a[0] + c[0]) / 2;
            const my = (a[1] + c[1]) / 2;
            const stroke = sel ? "#2f5d7c" : kind === "exterior-side" ? "#b3392b" : kind === "exterior-main" ? "#111111" : "#1a1a1a";
            const marker = kind === "exterior-side" ? "door-arrow-side" : kind === "exterior-main" ? "door-arrow-main" : "door-arrow";
            return (
              <g key={arrow.id} className={`arrow ${kind} ${sel ? "selected" : ""}`} pointerEvents="all" onPointerDown={(e) => startArrowDrag(e, arrow)}>
                {/* a fat invisible stroke so a thin arrow is easy to grab */}
                <line x1={a[0]} y1={a[1]} x2={c[0]} y2={c[1]} stroke="transparent" strokeWidth={0.5} />
                <line
                  x1={a[0]}
                  y1={a[1]}
                  x2={c[0]}
                  y2={c[1]}
                  stroke={stroke}
                  strokeOpacity={sel || kind !== "interior" ? 1 : 0.55}
                  strokeWidth={sel ? 0.1 : kind !== "interior" ? 0.09 : 0.07}
                  markerEnd={`url(#${marker})`}
                />
                {sel && (
                  <>
                    <circle className="handle flip" cx={mx + 0.7} cy={my - 0.7} r={HANDLE / 2} onPointerDown={(e) => onFlipArrow(e, arrow)}>
                      <title>Flip the arrow</title>
                    </circle>
                    <text x={mx + 0.7} y={my - 0.7} className="handle-glyph" textAnchor="middle" dominantBaseline="middle">
                      ⇅
                    </text>
                    <circle className="handle delete" cx={mx + 1.25} cy={my - 0.7} r={HANDLE / 2} onPointerDown={(e) => onDeleteArrow(e, arrow)}>
                      <title>Delete the arrow</title>
                    </circle>
                    <text x={mx + 1.25} y={my - 0.7} className="handle-glyph" textAnchor="middle" dominantBaseline="middle">
                      ×
                    </text>
                  </>
                )}
              </g>
            );
          })}
          {/* the marquee, or the zone being drawn */}
          {rubber && gesture.current?.kind === "marquee" && (
            <rect x={rubber.left} y={rubber.top} width={rubber.width} height={rubber.height} className="marquee" />
          )}
          {rubber && gesture.current?.kind === "draw" && (
            gesture.current.shape === "circle" ? (
              <ellipse cx={rubber.left + rubber.width / 2} cy={rubber.top + rubber.height / 2} rx={rubber.width / 2} ry={rubber.height / 2} className="drawing" />
            ) : (
              <rect x={rubber.left} y={rubber.top} width={rubber.width} height={rubber.height} className="drawing" />
            )
          )}
          {rubber && gesture.current?.kind === "draw" && rubber.width > 0 && (
            <text x={rubber.left + rubber.width / 2} y={rubber.top - 0.3} className="anno" textAnchor="middle" style={{ fontSize: 0.42 }}>
              {rubber.width.toFixed(2)} × {rubber.height.toFixed(2)} m
            </text>
          )}
          {/* the polygon tool's corners so far, and the wall it would
              draw next */}
          {tool === "polygon" && polyDraft && polyDraft.length > 0 && (
            <>
              <polyline
                points={pointsOf(polyCursor ? [...polyDraft, polyCursor] : polyDraft)}
                fill="none"
                className="drawing"
              />
              {polyDraft.length >= 3 && (
                <circle className="handle poly-close" cx={polyDraft[0][0]} cy={polyDraft[0][1]} r={HANDLE / 2}>
                  <title>Click to close the polygon here</title>
                </circle>
              )}
              {polyDraft.map(([x, y], i) => (
                <circle key={i} className="poly-vertex" cx={x} cy={y} r={0.08} />
              ))}
            </>
          )}
          {/* the zone waiting to be placed, following the pointer at its own size */}
          {tool === "place" &&
            placeCursor &&
            (() => {
              const box = boxes.find((b) => b.id === placingId);
              if (!box) return null;
              const left = placeCursor.x - box.width / 2;
              const top = placeCursor.y - box.height / 2;
              return box.shape === "circle" ? (
                <ellipse cx={placeCursor.x} cy={placeCursor.y} rx={box.width / 2} ry={box.height / 2} className="drawing" />
              ) : (
                <rect x={left} y={top} width={box.width} height={box.height} className="drawing" />
              );
            })()}

          {/* How long a metre is. Sits below the sheet so it never covers
              a zone. */}
          <g transform={`translate(0 ${depth + 1.3})`}>
            {[0, 1, 2, 3].map((i) => (
              <rect
                key={i}
                x={i * (scaleBarM / 2)}
                y={0}
                width={scaleBarM / 2}
                height={0.34}
                fill={i % 2 ? INK.sheet : INK.footprint}
                stroke={INK.footprint}
                strokeWidth={0.035}
              />
            ))}
            <text x={0} y={1.1} className="anno" style={{ fontSize: 0.46 }}>
              0
            </text>
            <text x={scaleBarM} y={1.1} textAnchor="middle" className="anno" style={{ fontSize: 0.46 }}>
              {scaleBarM}
            </text>
            <text x={scaleBarM * 2} y={1.1} textAnchor="middle" className="anno" style={{ fontSize: 0.46 }}>
              {scaleBarM * 2} m
            </text>
          </g>
        </g>
        </g>
      </svg>

      <div className="pane-tools zoomer">
        <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => setCam((c) => ({ ...c, z: Math.max(MIN_ZOOM, c.z / 1.3) }))}>
          <IconMinus />
        </button>
        <span className="pct num">{Math.round(cam.z * 100)} %</span>
        <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => setCam((c) => ({ ...c, z: Math.min(MAX_ZOOM, c.z * 1.3) }))}>
          <IconPlus />
        </button>
        <span className="sep" />
        <button type="button" title="Fit the building" aria-label="Fit the building" onClick={fit}>
          <IconFit />
        </button>
      </div>
    </div>
  );
}

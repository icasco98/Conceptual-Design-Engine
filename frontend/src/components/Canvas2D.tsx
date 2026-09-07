/**
 * The plan: every zone on the current storey as a shape you can select,
 * drag, resize (corner handles), rotate (top handle) and delete, over a
 * blank sheet and, on an upper level, the dashed outline of the storey
 * below. The building outline recomputes from wherever the zones are.
 *
 * Door arrows are yours: each sits on a wall of its host zone, always
 * perpendicular to it. Drag one to slide it along the wall or onto
 * another wall of the same zone; the handles flip or delete it; the
 * Arrow tool puts a new one on the wall you click.
 *
 * Tools (the rail): Select rubber-bands a selection when you drag empty
 * sheet; Pan moves the view; Rectangle and Circle draw a new zone. With
 * several zones selected, dragging any of them moves them all, the rotate
 * handle turns them together about the group's centre, and × or Delete
 * removes them all.
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
import { polyArea, polyOfBox } from "../geometry/poly";
import { isOpenToBelow, liveBoxes, snapToGrid, snapToNearbyNeighbors } from "../geometry/snap";
import { GRID_M, type Arrow, type Box, type Poly, type Rect } from "../geometry/types";
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
  | { kind: "resize"; id: string; corner: Corner; start: Rect; startX: number; startY: number; snapshot: Box[] }
  | { kind: "rotate"; ids: string[]; cx: number; cy: number; startAngle: number; snapshot: Box[] }
  | { kind: "marquee"; x0: number; y0: number; additive: boolean }
  | { kind: "draw"; shape: "rect" | "circle"; x0: number; y0: number }
  | { kind: "arrow"; id: string };

function pointsOf(poly: Poly): string {
  return poly.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(" ");
}

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

export function Canvas2D() {
  const boxes = useStore((s) => s.boxes);
  const recommended = useStore((s) => s.recommended);
  const level = useStore((s) => s.level);
  const selected = useStore((s) => s.selected);
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const select = useStore((s) => s.select);
  const selectMany = useStore((s) => s.selectMany);
  const addBox = useStore((s) => s.addBox);
  const setBoxes = useStore((s) => s.setBoxes);
  const commitBoxes = useStore((s) => s.commitBoxes);
  const deleteBoxes = useStore((s) => s.deleteBoxes);
  const carve = useStore((s) => s.carve);
  const release = useStore((s) => s.release);
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
      const dx = p.x - g.startX;
      const dy = p.y - g.startY;
      let { left, top, width: w, height: h } = g.start;
      if (g.corner === "ne" || g.corner === "se") {
        const right = snapToGrid(g.start.left + g.start.width + dx);
        w = Math.max(box.minWidth, right - left);
      }
      if (g.corner === "nw" || g.corner === "sw") {
        const newLeft = snapToGrid(g.start.left + dx);
        w = Math.max(box.minWidth, g.start.left + g.start.width - newLeft);
        left = g.start.left + g.start.width - w;
      }
      if (g.corner === "se" || g.corner === "sw") {
        const bottom = snapToGrid(g.start.top + g.start.height + dy);
        h = Math.max(box.minHeight, bottom - top);
      }
      if (g.corner === "ne" || g.corner === "nw") {
        const newTop = snapToGrid(g.start.top + dy);
        h = Math.max(box.minHeight, g.start.top + g.start.height - newTop);
        top = g.start.top + g.start.height - h;
      }
      // Held to what the plot allows from where the zone started, so the
      // corner you are not dragging stays exactly where it is.
      const next = limitGrowth(box, { ...box, left, top, width: w, height: h }, plotRef.current, "inside");
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
        deleteBoxes(state.selected);
      } else if (e.key === "Escape") {
        select(null);
        selectArrow(null);
        setTool("select");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteArrow, deleteBoxes, select, selectArrow, setTool]);

  const startMove = (e: React.PointerEvent, b: Box) => {
    if (tool === "rect" || tool === "circle") return; // drawing starts on the sheet below
    e.stopPropagation();
    e.preventDefault();
    if (tool === "arrow") {
      // A zone open to below has no floor on this storey, so no door.
      if (!isOpenToBelow(b, level)) {
        const p = toMeters(e);
        addArrow(b.id, [p.x, p.y]);
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
    gesture.current = {
      kind: "resize",
      id: b.id,
      corner,
      start: { left: b.left, top: b.top, width: b.width, height: b.height },
      startX: p.x,
      startY: p.y,
      snapshot: live,
    };
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
    deleteBoxes(selected.includes(b.id) && selected.length > 1 ? selected : [b.id]);
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
      // Only the background, unless drawing: a new zone may be drawn over
      // an existing one, since zones are allowed to overlap.
      if (!drawing && e.target !== e.currentTarget) return;
      const middle = e.button === 1;
      if (tool === "pan" || middle) {
        e.currentTarget.setPointerCapture(e.pointerId);
        pan.current = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
        setPanning(true);
        return;
      }
      const p = toMeters(e);
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
    [cam.x, cam.y, selectArrow, setRubber, toMeters, tool],
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
    <div className={`plan-pane tool-${tool}`} style={{ cursor }}>
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
      </div>
      {(tool === "rect" || tool === "circle") && (
        <div className="pane-hint">
          Drag on the sheet to draw a {tool === "rect" ? "rectangle (hold Shift for a square)" : "circle"}. Esc to cancel.
        </div>
      )}
      {tool === "arrow" && <div className="pane-hint">Click a zone's wall to put a door arrow on it. Esc to cancel.</div>}
      <svg
        ref={svgRef}
        className="plan-svg"
        viewBox={`0 0 ${svgW} ${svgH}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerMove={(e) => {
          onPointerMove(e);
          onPanMove(e);
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
                {isSel && (
                  <>
                    <line x1={cx} y1={b.top} x2={cx} y2={b.top - 0.9} stroke="#0b0b0b" strokeWidth={0.04} />
                    <circle className="handle rotate" cx={cx} cy={b.top - 1.1} r={HANDLE / 2} onPointerDown={(e) => startRotate(e, b)} />
                    <text x={cx} y={b.top - 1.1} className="handle-glyph" textAnchor="middle" dominantBaseline="middle">
                      ↻
                    </text>
                    <circle className="handle delete" cx={b.left + b.width + 0.55} cy={b.top - 0.55} r={HANDLE / 2} onPointerDown={(e) => onDelete(e, b)} />
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
                  </>
                )}
              </g>
            );
          })}
          {/* door arrows: on their host's wall, perpendicular to it */}
          {liveArrows.map(({ arrow, host }) => {
            const [a, c] = arrowSegment(host, arrow);
            const sel = arrow.id === selectedArrow;
            const mx = (a[0] + c[0]) / 2;
            const my = (a[1] + c[1]) / 2;
            return (
              <g key={arrow.id} className={`arrow ${sel ? "selected" : ""}`} pointerEvents="all" onPointerDown={(e) => startArrowDrag(e, arrow)}>
                {/* a fat invisible stroke so a thin arrow is easy to grab */}
                <line x1={a[0]} y1={a[1]} x2={c[0]} y2={c[1]} stroke="transparent" strokeWidth={0.5} />
                <line
                  x1={a[0]}
                  y1={a[1]}
                  x2={c[0]}
                  y2={c[1]}
                  stroke={sel ? "#2f5d7c" : "#1a1a1a"}
                  strokeOpacity={sel ? 1 : 0.55}
                  strokeWidth={sel ? 0.1 : 0.07}
                  markerEnd="url(#door-arrow)"
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

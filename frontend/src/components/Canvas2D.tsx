/**
 * The plan: every room and hallway on the current storey as a box you can
 * drag, resize (corner handles), rotate (top handle, 5° steps) and delete,
 * over the site outline, the setback line and, on an upper level, a ghost
 * of the storey below. The building outline and door arrows recompute
 * from wherever the boxes are now.
 *
 * All geometry is in plan-frame meters (geometry/types.ts). The SVG's
 * inner group scales meters to pixels, so pointer positions are read back
 * in meters through its inverse screen matrix and nothing here ever
 * thinks in pixels.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CategoryKey } from "../api/types";
import { displayShapes } from "../geometry/carve";
import { doorArrows } from "../geometry/doors";
import { footprintRings, ringsToPath } from "../geometry/footprint";
import {
  clamp,
  clampPositionOnly,
  liveBoxes,
  resolveOverlaps,
  rotationIsAllowed,
  snapToGrid,
  snapToNearbyNeighbors,
} from "../geometry/resolve";
import { effectiveRectOf } from "../geometry/rect";
import { GRID_M, type Box, type Poly, type Rect } from "../geometry/types";
import { fillFor } from "../palette";
import { useStore } from "../state/store";

const PX = 26;
const MARGIN = 34;
const HEADROOM = 20;
const HANDLE = 0.42;
const WET_TYPES = new Set(["bathroom", "half_bath", "kitchen", "laundry"]);

type Corner = "nw" | "ne" | "sw" | "se";

type Gesture =
  | { kind: "move"; id: string; offX: number; offY: number; snapshot: Box[] }
  | { kind: "resize"; id: string; corner: Corner; start: Rect; startX: number; startY: number; snapshot: Box[] }
  | { kind: "rotate"; ids: string[]; cx: number; cy: number; startAngle: number; startRotations: number[]; lastGood: Box[]; snapshot: Box[] };

function pointsOf(poly: Poly): string {
  return poly.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(" ");
}

export function Canvas2D() {
  const project = useStore((s) => s.project);
  const boxes = useStore((s) => s.boxes);
  const level = useStore((s) => s.level);
  const envelope = useStore((s) => s.envelope);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const setBoxes = useStore((s) => s.setBoxes);
  const commitBoxes = useStore((s) => s.commitBoxes);
  const deleteBoxes = useStore((s) => s.deleteBoxes);
  const showGrid = useStore((s) => s.showGrid);
  const showGhost = useStore((s) => s.showGhost);
  const layoutPlan = useStore((s) => s.layoutPlan);

  const gRef = useRef<SVGGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const pending = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef(0);
  const [pinnedId, setPinnedId] = useState<string | null>(null);

  const live = useMemo(() => liveBoxes(boxes, level), [boxes, level]);
  const below = useMemo(
    () => (showGhost && level > 0 ? liveBoxes(boxes, level - 1) : []),
    [boxes, level, showGhost],
  );
  const shapes = useMemo(() => displayShapes(live, pinnedId), [live, pinnedId]);
  const footprint = useMemo(() => ringsToPath(footprintRings(shapes.map((s) => s.page))), [shapes]);
  const arrows = useMemo(() => doorArrows(live), [live]);
  const categories = useMemo(() => {
    const m = new Map<string, CategoryKey>();
    layoutPlan?.assignments.forEach((a) => m.set(a.room_name, a.category));
    return m;
  }, [layoutPlan]);

  const width = project?.site.width_m ?? 0;
  const depth = project?.site.depth_m ?? 0;
  const svgW = width * PX + 2 * MARGIN;
  const svgH = depth * PX + 2 * MARGIN + HEADROOM;

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

  const categoryOf = (b: Box) => {
    const base = b.name.replace(/ \d+$/, "");
    return categories.get(b.name) ?? categories.get(base);
  };

  // ---- gestures ---------------------------------------------------------

  const runFrame = useCallback(() => {
    frame.current = 0;
    const g = gesture.current;
    const p = pending.current;
    if (!g || !p || !envelope) return;
    pending.current = null;
    const restored = g.snapshot;

    if (g.kind === "move") {
      const active = restored.find((b) => b.id === g.id)!;
      let next: Box = { ...active, left: p.x - g.offX, top: p.y - g.offY };
      const eff = effectiveRectOf(next);
      const padLeft = next.left - eff.left;
      const padTop = next.top - eff.top;
      next = {
        ...next,
        left: clamp(next.left, envelope.left + padLeft, envelope.right - eff.width + padLeft),
        top: clamp(next.top, envelope.top + padTop, envelope.bottom - eff.height + padTop),
      };
      const others = restored.filter((b) => b.id !== g.id);
      if (!next.rotation) {
        next = { ...next, left: snapToGrid(next.left), top: snapToGrid(next.top) };
        next = snapToNearbyNeighbors(next, [...others, next]);
      }
      next = clampPositionOnly(next, envelope);
      const resolved = resolveOverlaps(restored.map((b) => (b.id === g.id ? next : b)), g.id, envelope);
      setBoxes(mergeRef.current(resolved));
    } else if (g.kind === "resize") {
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
      const next = clampPositionOnly({ ...box, left, top, width: w, height: h }, envelope);
      const resolved = resolveOverlaps(restored.map((b) => (b.id === g.id ? next : b)), g.id, envelope);
      setBoxes(mergeRef.current(resolved));
    } else {
      const angle = (Math.atan2(p.y - g.cy, p.x - g.cx) * 180) / Math.PI + 90;
      const delta = Math.round((angle - g.startAngle) / 5) * 5;
      const targets = new Set(g.ids);
      let turned = g.lastGood.map((b) => {
        if (!targets.has(b.id)) return b;
        const i = g.ids.indexOf(b.id);
        return clampPositionOnly({ ...b, rotation: g.startRotations[i] + delta }, envelope);
      });
      if (!rotationIsAllowed(turned.filter((b) => targets.has(b.id)), turned)) {
        turned = g.lastGood;
      } else {
        g.lastGood = turned;
      }
      setBoxes(mergeRef.current(turned));
    }
  }, [envelope, setBoxes]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!gesture.current) return;
      pending.current = toMeters(e);
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
    setPinnedId(null);
    if (!g || !envelope) return;
    const state = useStore.getState();
    const current = liveBoxes(state.boxes, state.level);
    const pinned = g.kind === "rotate" ? (g.ids.length === 1 ? g.ids[0] : null) : g.id;
    const settled = resolveOverlaps(current, pinned, envelope);
    const byId = new Map(settled.map((b) => [b.id, b]));
    commitBoxes(state.boxes.map((b) => byId.get(b.id) ?? b));
  }, [commitBoxes, envelope, runFrame]);

  useEffect(() => {
    const up = () => endGesture();
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [endGesture]);

  const startMove = (e: React.PointerEvent, b: Box) => {
    e.stopPropagation();
    e.preventDefault();
    select(b.id, e.shiftKey);
    const p = toMeters(e);
    gesture.current = { kind: "move", id: b.id, offX: p.x - b.left, offY: p.y - b.top, snapshot: live };
    setPinnedId(b.id);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const startResize = (e: React.PointerEvent, b: Box, corner: Corner) => {
    e.stopPropagation();
    e.preventDefault();
    const p = toMeters(e);
    gesture.current = {
      kind: "resize",
      id: b.id,
      corner,
      start: { left: b.left, top: b.top, width: b.width, height: b.height },
      startX: p.x,
      startY: p.y,
      snapshot: live,
    };
    setPinnedId(b.id);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const startRotate = (e: React.PointerEvent, b: Box) => {
    e.stopPropagation();
    e.preventDefault();
    const ids = selected.includes(b.id) && selected.length > 1 ? [...selected] : [b.id];
    const cx = b.left + b.width / 2;
    const cy = b.top + b.height / 2;
    const p = toMeters(e);
    const startAngle = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90;
    gesture.current = {
      kind: "rotate",
      ids,
      cx,
      cy,
      startAngle,
      startRotations: ids.map((id) => live.find((x) => x.id === id)?.rotation ?? 0),
      lastGood: live,
      snapshot: live,
    };
    setPinnedId(ids.length === 1 ? ids[0] : null);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const onDelete = (e: React.PointerEvent, b: Box) => {
    e.stopPropagation();
    e.preventDefault();
    deleteBoxes(selected.includes(b.id) && selected.length > 1 ? selected : [b.id]);
  };

  if (!project || !envelope) return null;

  const streetEdges = new Set(project.site.edges.filter((e) => e.adjacency === "street").map((e) => e.position));

  return (
    <div className="canvas-wrap">
      <div className="legend">
        {layoutPlan &&
          (["category_a", "category_b", "category_c"] as CategoryKey[]).map((k) => (
            <span key={k} className="legend-item">
              <i style={{ background: fillFor("x", "room", k) }} /> {layoutPlan.category_labels[k]}
            </span>
          ))}
        <span className="legend-item">
          <i className="legend-hall" /> Hallway
        </span>
        <span className="legend-item">
          <i style={{ background: fillFor("stair", "room", undefined) }} /> Stair (shared by every level)
        </span>
        <span className="legend-item">
          <i className="legend-entry" /> Entry
        </span>
        <span className="legend-item">→ Door</span>
      </div>
      <svg
        className="plan"
        viewBox={`0 0 ${svgW} ${svgH}`}
        style={{ width: "100%", maxWidth: svgW, height: "auto" }}
        onPointerMove={onPointerMove}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) select(null);
        }}
      >
        <defs>
          <pattern id="grid" width={GRID_M} height={GRID_M} patternUnits="userSpaceOnUse">
            <path d={`M ${GRID_M} 0 L 0 0 0 ${GRID_M}`} fill="none" stroke="#000" strokeOpacity="0.08" strokeWidth={0.02} />
          </pattern>
          <pattern id="hatch" width={0.5} height={0.5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2={0.5} stroke="#777" strokeWidth={0.06} />
          </pattern>
          <marker id="door-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse" markerUnits="strokeWidth">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#1a1a1a" fillOpacity="0.6" />
          </marker>
        </defs>
        <text x={MARGIN + (width * PX) / 2} y={MARGIN + HEADROOM - 6} textAnchor="middle" className="street-label">
          {streetEdges.has("front") ? "STREET" : ""}
        </text>
        <g ref={gRef} transform={`translate(${MARGIN} ${MARGIN + HEADROOM}) scale(${PX})`}>
          {/* site */}
          <rect x={0} y={0} width={width} height={depth} fill="#fbfbf9" stroke="#444" strokeWidth={0.06} />
          {showGrid && <rect x={0} y={0} width={width} height={depth} fill="url(#grid)" />}
          {/* street edges */}
          {streetEdges.has("front") && <line x1={0} y1={0} x2={width} y2={0} stroke="#c0392b" strokeWidth={0.16} />}
          {streetEdges.has("back") && <line x1={0} y1={depth} x2={width} y2={depth} stroke="#c0392b" strokeWidth={0.16} />}
          {streetEdges.has("left") && <line x1={0} y1={0} x2={0} y2={depth} stroke="#c0392b" strokeWidth={0.16} />}
          {streetEdges.has("right") && <line x1={width} y1={0} x2={width} y2={depth} stroke="#c0392b" strokeWidth={0.16} />}
          {/* setback line */}
          <rect
            x={envelope.left}
            y={envelope.top}
            width={envelope.right - envelope.left}
            height={envelope.bottom - envelope.top}
            fill="none"
            stroke="#c9a227"
            strokeWidth={0.05}
            strokeDasharray="0.4 0.25"
          />
          {/* ghost of the level below */}
          {below.map((b) => {
            const cx = b.left + b.width / 2;
            const cy = b.top + b.height / 2;
            const wet = WET_TYPES.has(b.roomType);
            return (
              <g key={`ghost-${b.id}`} transform={`rotate(${b.rotation} ${cx} ${cy})`} className="ghost">
                <rect
                  x={b.left}
                  y={b.top}
                  width={b.width}
                  height={b.height}
                  fill={wet ? "#2a78d6" : "none"}
                  fillOpacity={wet ? 0.12 : 0}
                  stroke="#888"
                  strokeWidth={0.04}
                  strokeDasharray="0.3 0.2"
                />
                <text x={cx} y={cy} className="ghost-label" textAnchor="middle" dominantBaseline="middle">
                  {b.name}
                </text>
              </g>
            );
          })}
          {/* footprint */}
          <path d={footprint} fill="none" stroke="#1a1a1a" strokeWidth={0.12} strokeLinejoin="round" />
          {/* boxes */}
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
            const fill = fillFor(b.roomType, b.kind, categoryOf(b));
            const sharedStair = b.roomType === "stair" && project.storeys > 1;
            // Labels shrink to fit narrow rooms rather than spilling over
            // the neighbour; below ~0.28 m they turn vertical instead.
            const labelText = b.name + (sharedStair ? " ⇅" : "");
            const fitWidth = Math.max(b.width, b.rotation ? b.width : 0);
            let fontSize = Math.min(0.5, fitWidth / (labelText.length * 0.6));
            const vertical = fontSize < 0.28 && b.height > b.width * 1.6;
            if (vertical) fontSize = Math.min(0.5, b.height / (labelText.length * 0.6));
            fontSize = Math.max(0.22, fontSize);
            return (
              <g
                key={b.id}
                className={`box ${b.kind} ${b.isEntry ? "entry" : ""} ${isSel ? "selected" : ""} ${shape?.carved ? "carved" : ""}`}
                transform={`rotate(${b.rotation} ${cx} ${cy})`}
                onPointerDown={(e) => startMove(e, b)}
              >
                <polygon
                  points={pointsOf(poly)}
                  fill={b.kind === "corridor" ? "url(#hatch)" : fill}
                  fillOpacity={b.kind === "corridor" ? 1 : 0.88}
                  stroke={b.isEntry ? "#0b0b0b" : isSel ? "#0b0b0b" : "#333"}
                  strokeWidth={b.isEntry ? 0.14 : isSel ? 0.12 : 0.05}
                  strokeDasharray={b.isEntry ? "0.35 0.2" : undefined}
                  strokeLinejoin="round"
                />
                {b.kind === "corridor" && (
                  <polygon points={pointsOf(poly)} fill="#e9e6dc" fillOpacity={0.55} stroke="none" />
                )}
                <text
                  x={cx}
                  y={cy}
                  className={`label ${b.kind === "corridor" ? "corridor-label" : ""}`}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  style={{ fontSize: `${fontSize}px` }}
                  transform={vertical ? `rotate(-90 ${cx} ${cy})` : undefined}
                >
                  {labelText}
                </text>
                {solo &&
                  (["nw", "ne", "sw", "se"] as Corner[]).map((c) => (
                    <rect
                      key={c}
                      className={`handle resize ${c}`}
                      x={(c.includes("e") ? b.left + b.width : b.left) - HANDLE / 2}
                      y={(c.includes("s") ? b.top + b.height : b.top) - HANDLE / 2}
                      width={HANDLE}
                      height={HANDLE}
                      onPointerDown={(e) => startResize(e, b, c)}
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
                  </>
                )}
              </g>
            );
          })}
          {/* door arrows */}
          {arrows.map(([a, c], i) => (
            <line
              key={i}
              x1={a[0]}
              y1={a[1]}
              x2={c[0]}
              y2={c[1]}
              stroke="#1a1a1a"
              strokeOpacity={0.55}
              strokeWidth={0.07}
              markerEnd="url(#door-arrow)"
              pointerEvents="none"
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

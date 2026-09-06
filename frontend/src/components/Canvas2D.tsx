/**
 * The plan: every room and hallway on the current storey as a box you can
 * drag, resize (corner handles), rotate (top handle, 5° steps) and delete,
 * over a blank sheet and, on an upper level, a ghost of the storey below.
 * The building outline and door arrows recompute from wherever the boxes
 * are now.
 *
 * Boxes overlap freely and nothing is ever pushed. The carve handle on a
 * selected box (top-left) cuts every room under it; pressing it again
 * releases the cut. A room cut below its minimum is outlined in red.
 *
 * There is no site and no setback line. The sheet is a faint rectangle
 * for reference and the ground plane of the 3D view; a room may be drawn
 * anywhere, on it or off it.
 *
 * All geometry is in plan-frame meters (geometry/types.ts). The SVG's
 * inner group scales meters to pixels, so pointer positions are read back
 * in meters through its inverse screen matrix and nothing here ever
 * thinks in pixels. The camera (pan and zoom) is an outer group wrapping
 * that one, which is why dragging a room still lands where the pointer is
 * at any zoom: the inverse screen matrix already carries the camera.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CategoryKey } from "../api/types";
import { displayShapes } from "../geometry/carve";
import { doorArrows } from "../geometry/doors";
import { footprintRings, ringsToPath } from "../geometry/footprint";
import { polyArea } from "../geometry/poly";
import { liveBoxes, snapToGrid, snapToNearbyNeighbors } from "../geometry/snap";
import { GRID_M, type Box, type Poly, type Rect } from "../geometry/types";
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
const WET_TYPES = new Set(["bathroom", "half_bath", "kitchen", "laundry"]);

type Corner = "nw" | "ne" | "sw" | "se";

type Gesture =
  | { kind: "move"; id: string; offX: number; offY: number; snapshot: Box[] }
  | { kind: "resize"; id: string; corner: Corner; start: Rect; startX: number; startY: number; snapshot: Box[] }
  | { kind: "rotate"; ids: string[]; cx: number; cy: number; startAngle: number; startRotations: number[]; snapshot: Box[] };

/** Keep the gesture even when the pointer leaves the element. A synthetic
 *  event has no pointer to capture, and that is not worth an exception. */
function capture(e: React.PointerEvent) {
  try {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  } catch {
    /* no live pointer */
  }
}

function pointsOf(poly: Poly): string {
  return poly.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(" ");
}

export function Canvas2D() {
  const boxes = useStore((s) => s.boxes);
  const level = useStore((s) => s.level);
  const storeys = useStore((s) => s.storeys);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const setBoxes = useStore((s) => s.setBoxes);
  const commitBoxes = useStore((s) => s.commitBoxes);
  const deleteBoxes = useStore((s) => s.deleteBoxes);
  const carve = useStore((s) => s.carve);
  const release = useStore((s) => s.release);
  const showGrid = useStore((s) => s.showGrid);
  const showGhost = useStore((s) => s.showGhost);

  const gRef = useRef<SVGGElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [cam, setCam] = useState({ z: 1, x: 0, y: 0 });
  const pan = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const pending = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef(0);

  const live = useMemo(() => liveBoxes(boxes, level), [boxes, level]);
  const below = useMemo(
    () => (showGhost && level > 0 ? liveBoxes(boxes, level - 1) : []),
    [boxes, level, showGhost],
  );
  const shapes = useMemo(() => displayShapes(live), [live]);
  const footprint = useMemo(() => ringsToPath(footprintRings(shapes.map((s) => s.page))), [shapes]);
  const arrows = useMemo(() => doorArrows(live), [live]);

  const width = SHEET.width;
  const depth = SHEET.depth;
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

  // ---- gestures ---------------------------------------------------------

  const runFrame = useCallback(() => {
    frame.current = 0;
    const g = gesture.current;
    const p = pending.current;
    if (!g || !p) return;
    pending.current = null;
    const restored = g.snapshot;

    if (g.kind === "move") {
      const active = restored.find((b) => b.id === g.id)!;
      let next: Box = { ...active, left: p.x - g.offX, top: p.y - g.offY };
      const others = restored.filter((b) => b.id !== g.id);
      if (!next.rotation) {
        next = { ...next, left: snapToGrid(next.left), top: snapToGrid(next.top) };
        next = snapToNearbyNeighbors(next, [...others, next]);
      }
      setBoxes(mergeRef.current(restored.map((b) => (b.id === g.id ? next : b))));
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
      const next = { ...box, left, top, width: w, height: h };
      setBoxes(mergeRef.current(restored.map((b) => (b.id === g.id ? next : b))));
    } else {
      const angle = (Math.atan2(p.y - g.cy, p.x - g.cx) * 180) / Math.PI + 90;
      const delta = Math.round((angle - g.startAngle) / 5) * 5;
      const targets = new Set(g.ids);
      const turned = restored.map((b) => {
        if (!targets.has(b.id)) return b;
        const i = g.ids.indexOf(b.id);
        return { ...b, rotation: g.startRotations[i] + delta };
      });
      setBoxes(mergeRef.current(turned));
    }
  }, [setBoxes]);

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
    if (!g) return;
    commitBoxes(useStore.getState().boxes);
  }, [commitBoxes, runFrame]);

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
    capture(e);
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
    capture(e);
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
      snapshot: live,
    };
    capture(e);
  };

  const onDelete = (e: React.PointerEvent, b: Box) => {
    e.stopPropagation();
    e.preventDefault();
    deleteBoxes(selected.includes(b.id) && selected.length > 1 ? selected : [b.id]);
  };

  /** Carve with this box, or release its cuts if it already carves
   *  everything it sits over. */
  const onCarve = (e: React.PointerEvent, b: Box) => {
    e.stopPropagation();
    e.preventDefault();
    if (carvesSomething(b)) release(b.id);
    else carve(b.id);
  };
  const carvesSomething = (b: Box) => live.some((o) => o.carvedBy.includes(b.id));

  // ---- camera -----------------------------------------------------------

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

  const onPanDown = useCallback((e: React.PointerEvent) => {
    // Only the background pans; a room swallows the event before this.
    if (e.target !== e.currentTarget) return;
    select(null);
    e.currentTarget.setPointerCapture(e.pointerId);
    pan.current = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
    setPanning(true);
  }, [cam.x, cam.y, select]);

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

  const fit = useCallback(() => setCam({ z: 1, x: 0, y: 0 }), []);

  const scaleBarM = 5;

  return (
    <div className={`plan-pane${panning ? " panning" : ""}`}>
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
      <svg
        ref={svgRef}
        className="plan-svg"
        viewBox={`0 0 ${svgW} ${svgH}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerMove={(e) => {
          onPointerMove(e);
          onPanMove(e);
        }}
        onPointerDown={onPanDown}
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
        <g transform={`translate(${cam.x} ${cam.y}) scale(${cam.z})`}>
        <g ref={gRef} transform={`translate(${MARGIN} ${MARGIN + HEADROOM}) scale(${PX})`}>
          {/* the sheet: a reference area, not a boundary */}
          <rect x={0} y={0} width={width} height={depth} fill={INK.sheet} stroke={INK.site} strokeWidth={0.04} strokeDasharray="0.3 0.3" />
          {showGrid && <rect x={0} y={0} width={width} height={depth} fill="url(#grid)" />}
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
          <path d={footprint} fill="none" stroke={INK.footprint} strokeWidth={0.2} strokeLinejoin="round" />
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
            const flagged = shape?.flagged ?? false;
            const carving = carvesSomething(b);
            const fill = fillFor(b.roomType, b.kind);
            const sharedStair = b.roomType === "stair" && storeys > 1;
            // Labels shrink to fit narrow rooms rather than spilling over
            // the neighbour; below ~0.28 m they turn vertical instead.
            const labelText = b.name + (sharedStair ? " ⇅" : "");
            let fontSize = Math.min(0.5, b.width / (labelText.length * 0.6));
            const vertical = fontSize < 0.28 && b.height > b.width * 1.6;
            // The area only fits under the name when the room has room for it.
            const showArea = !vertical && b.kind === "room" && b.height > 2.2 && b.width > 2.2;
            if (vertical) fontSize = Math.min(0.5, b.height / (labelText.length * 0.6));
            fontSize = Math.max(0.22, fontSize);
            return (
              <g
                key={b.id}
                className={`box ${b.kind} ${b.isEntry ? "entry" : ""} ${isSel ? "selected" : ""} ${shape?.carved ? "carved" : ""} ${flagged ? "flagged" : ""}`}
                transform={`rotate(${b.rotation} ${cx} ${cy})`}
                onPointerDown={(e) => startMove(e, b)}
              >
                <polygon
                  points={pointsOf(poly)}
                  fill={b.kind === "corridor" ? "url(#hatch)" : fill}
                  fillOpacity={b.kind === "corridor" ? 1 : isSel ? CATEGORY_WASH * 2 : CATEGORY_WASH}
                  stroke={flagged ? INK.flag : b.isEntry || isSel ? "#0b0b0b" : INK.room}
                  strokeWidth={flagged || b.isEntry || isSel ? 0.12 : 0.05}
                  strokeDasharray={b.isEntry ? "0.35 0.2" : undefined}
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
                {showArea && (
                  <text x={cx} y={cy + 0.82} className="area-label" textAnchor="middle" style={{ fontSize: 0.44 }}>
                    {(shape ? polyArea(shape.page) : b.width * b.height).toFixed(1)} m²
                  </text>
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
                    {solo && (
                      <>
                        <title>{carving ? "Release: stop carving the rooms under this one" : "Carve the rooms under this one"}</title>
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

          {/* How long a metre is. Sits below the sheet so it never covers
              a room. */}
          <g pointerEvents="none" transform={`translate(0 ${depth + 1.3})`}>
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
        <button type="button" title="Fit the whole sheet" aria-label="Fit the whole sheet" onClick={fit}>
          <IconFit />
        </button>
      </div>
    </div>
  );
}

/**
 * The room schedule: one row per zone on the current storey, every column
 * live with the canvas in both directions. Name, type, floor, width,
 * depth and rotation are edited here and the zone follows; select a zone
 * on the plan and its row lights up, click a row and the zone is selected.
 */
import { useMemo } from "react";

import { displayShapes } from "../geometry/carve";
import { polyArea } from "../geometry/poly";
import { isOpenToBelow, liveBoxes } from "../geometry/snap";
import type { Box } from "../geometry/types";
import { fillFor } from "../palette";
import { ROOM_TYPES } from "../rooms";
import { useStore } from "../state/store";

function floorLabel(i: number): string {
  return i === 0 ? "G" : String(i);
}

export function Schedule() {
  const boxes = useStore((s) => s.boxes);
  const level = useStore((s) => s.level);
  const storeys = useStore((s) => s.storeys);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const deleteBoxes = useStore((s) => s.deleteBoxes);
  const updateBox = useStore((s) => s.updateBox);
  const carve = useStore((s) => s.carve);
  const release = useStore((s) => s.release);
  const autoCarve = useStore((s) => s.autoCarve);

  const live = useMemo(() => liveBoxes(boxes, level), [boxes, level]);
  const shapes = useMemo(() => displayShapes(live, autoCarve), [live, autoCarve]);
  const carvesSomething = (b: Box) => live.some((o) => o.carvedBy.includes(b.id));
  const areaOf = (b: Box) => {
    const s = shapes.find((x) => x.id === b.id);
    return s ? polyArea(s.page) : b.width * b.height;
  };

  /** Resize about the zone's own centre, so a number typed here does not
   *  also move it. Through updateBox, so it joins the undo history. */
  const edit = (b: Box, axis: "w" | "h", meters: number) => {
    if (!isFinite(meters) || meters <= 0) return;
    if (axis === "w") {
      const w = Math.max(b.minWidth, meters);
      updateBox(b.id, { left: b.left + (b.width - w) / 2, width: w });
    } else {
      const h = Math.max(b.minHeight, meters);
      updateBox(b.id, { top: b.top + (b.height - h) / 2, height: h });
    }
  };

  const editRotation = (b: Box, degrees: number) => {
    if (!isFinite(degrees)) return;
    updateBox(b.id, { rotation: ((Math.round(degrees) % 360) + 360) % 360 });
  };

  return (
    <div className="schedule">
      <table>
        <thead>
          <tr>
            <th>Space</th>
            <th>Type</th>
            <th>Floor</th>
            <th className="r">Width</th>
            <th className="r">Depth</th>
            <th className="r" title="Vertical height. Taller than a storey and the zone reaches the storey above.">Height</th>
            <th className="r">Area</th>
            <th className="r">Rot.</th>
            <th className="r" title="1 is the highest. With automatic carving on, a zone is carved by anything it overlaps that outranks it.">
              Pri.
            </th>
            <th />
            <th />
          </tr>
        </thead>
        <tbody>
          {live.map((b) => {
            const shape = shapes.find((s) => s.id === b.id);
            const carved = shape?.carved;
            const flagged = shape?.flagged;
            const carving = carvesSomething(b);
            const spans = b.levelTo > b.level;
            const openBelow = isOpenToBelow(b, level);
            return (
              <tr
                key={b.id}
                className={`${selected.includes(b.id) ? "selected" : ""} ${flagged ? "flagged" : ""} ${openBelow ? "open-below" : ""}`}
                onClick={(e) => {
                  const t = e.target as HTMLElement;
                  if (t.tagName === "INPUT" || t.tagName === "BUTTON" || t.tagName === "SELECT") return;
                  select(b.id, e.shiftKey);
                }}
              >
                <td className="name">
                  <i style={{ background: fillFor(b.roomType, b.kind), borderRadius: b.shape === "circle" ? "50%" : 2 }} />
                  <input
                    type="text"
                    className="name-input"
                    defaultValue={b.name}
                    key={`n${b.name}`}
                    onFocus={() => select(b.id)}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== b.name) updateBox(b.id, { name: v });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                  />
                </td>
                <td>
                  <select
                    className="type-select"
                    value={b.roomType}
                    title={ROOM_TYPES[b.roomType]?.label}
                    onFocus={() => select(b.id)}
                    onChange={(e) => updateBox(b.id, { roomType: e.target.value })}
                  >
                    {Object.entries(ROOM_TYPES).map(([key, info]) => (
                      <option key={key} value={key}>
                        {info.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {spans ? (
                    <span className="num" title="Spans several storeys">
                      {floorLabel(b.level)}–{floorLabel(b.levelTo)}
                    </span>
                  ) : (
                    <select
                      className="floor-select"
                      value={b.level}
                      onFocus={() => select(b.id)}
                      onChange={(e) => updateBox(b.id, { level: parseInt(e.target.value, 10) })}
                    >
                      {Array.from({ length: storeys }, (_, i) => (
                        <option key={i} value={i}>
                          {floorLabel(i)}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td className="r">
                  <input
                    type="number"
                    step="0.05"
                    min={b.minWidth.toFixed(2)}
                    defaultValue={b.width.toFixed(2)}
                    key={`w${b.width.toFixed(3)}`}
                    onFocus={() => select(b.id)}
                    onChange={(e) => edit(b, "w", parseFloat(e.target.value))}
                  />
                </td>
                <td className="r">
                  <input
                    type="number"
                    step="0.05"
                    min={b.minHeight.toFixed(2)}
                    defaultValue={b.height.toFixed(2)}
                    key={`h${b.height.toFixed(3)}`}
                    onFocus={() => select(b.id)}
                    onChange={(e) => edit(b, "h", parseFloat(e.target.value))}
                  />
                </td>
                <td className="r">
                  <input
                    type="number"
                    step="0.1"
                    min="0.5"
                    defaultValue={b.heightM.toFixed(1)}
                    key={`z${b.heightM.toFixed(2)}`}
                    title="Height in m"
                    onFocus={() => select(b.id)}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (isFinite(v) && v >= 0.5) updateBox(b.id, { heightM: v });
                    }}
                  />
                </td>
                <td
                  className={`r num ${flagged ? "flag" : carved ? "carved" : ""}`}
                  title={openBelow ? "Open to below: this zone's floor is the storey underneath" : flagged ? "Carved below its minimum size, or cut in two" : carved ? "Carved by another zone" : ""}
                >
                  {openBelow ? "void" : `${flagged ? "! " : ""}${areaOf(b).toFixed(1)}`}
                </td>
                <td className="r">
                  <input
                    type="number"
                    step="1"
                    className="rot"
                    defaultValue={b.rotation}
                    key={`r${b.rotation}`}
                    onFocus={() => select(b.id)}
                    onChange={(e) => editRotation(b, parseFloat(e.target.value))}
                  />
                </td>
                <td className="r">
                  <input
                    type="number"
                    step="1"
                    min="1"
                    className="rot"
                    defaultValue={b.priority}
                    key={`p${b.priority}`}
                    title="Priority: 1 is the highest"
                    onFocus={() => select(b.id)}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (isFinite(v) && v >= 1) updateBox(b.id, { priority: v });
                    }}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className={`carve-btn ${carving ? "on" : ""}`}
                    title={carving ? "Release: stop carving the zones under this one" : "Carve the zones under this one"}
                    aria-label={carving ? "Release the carve" : "Carve"}
                    onClick={() => (carving ? release(b.id) : carve(b.id))}
                  >
                    {carving ? "⊟" : "⊠"}
                  </button>
                </td>
                <td>
                  <button
                    type="button"
                    className="icon"
                    title="Delete"
                    onClick={() => deleteBoxes(selected.includes(b.id) && selected.length > 1 ? selected : [b.id])}
                  >
                    ×
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="schedule-foot muted">
        Width, depth and height in m, area in m², rotation in degrees. A zone taller than 3.0 m reaches the storey above.
        Priority 1 is the highest; it decides which zone gives way when automatic carving is on.
      </p>
    </div>
  );
}

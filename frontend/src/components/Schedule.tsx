import { useMemo } from "react";

import { displayShapes } from "../geometry/carve";
import { polyArea } from "../geometry/poly";
import { liveBoxes } from "../geometry/snap";
import type { Box } from "../geometry/types";
import { fillFor } from "../palette";
import { useStore } from "../state/store";

export function Schedule() {
  const boxes = useStore((s) => s.boxes);
  const level = useStore((s) => s.level);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const deleteBoxes = useStore((s) => s.deleteBoxes);
  const commitBoxes = useStore((s) => s.commitBoxes);
  const carve = useStore((s) => s.carve);
  const release = useStore((s) => s.release);

  const live = useMemo(() => liveBoxes(boxes, level), [boxes, level]);
  const shapes = useMemo(() => displayShapes(live), [live]);
  const carvesSomething = (b: Box) => live.some((o) => o.carvedBy.includes(b.id));
  const areaOf = (b: Box) => {
    const s = shapes.find((x) => x.id === b.id);
    return s ? polyArea(s.page) : b.width * b.height;
  };

  const edit = (b: Box, axis: "w" | "h", meters: number) => {
    if (!isFinite(meters) || meters <= 0) return;
    let next: Box;
    if (axis === "w") {
      const w = Math.max(b.minWidth, meters);
      next = { ...b, left: b.left + (b.width - w) / 2, width: w };
    } else {
      const h = Math.max(b.minHeight, meters);
      next = { ...b, top: b.top + (b.height - h) / 2, height: h };
    }
    commitBoxes(boxes.map((x) => (x.id === b.id ? next : x)));
  };

  return (
    <div className="schedule">
      <table>
        <thead>
          <tr>
            <th>Space</th>
            <th className="r">Width</th>
            <th className="r">Depth</th>
            <th className="r">Area</th>
            <th className="r">Rot.</th>
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
            return (
              <tr
                key={b.id}
                className={`${selected.includes(b.id) ? "selected" : ""} ${flagged ? "flagged" : ""}`}
                onClick={(e) => {
                  const t = e.target as HTMLElement;
                  if (t.tagName === "INPUT" || t.tagName === "BUTTON") return;
                  select(b.id, e.shiftKey);
                }}
              >
                <td className="name">
                  <i style={{ background: fillFor(b.roomType, b.kind) }} />
                  {b.name}
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
                <td
                  className={`r num ${flagged ? "flag" : carved ? "carved" : ""}`}
                  title={flagged ? "Carved below its minimum size, or cut in two" : carved ? "Carved by another room" : ""}
                >
                  {flagged ? "! " : ""}
                  {areaOf(b).toFixed(1)} m²
                </td>
                <td className="r num">{b.rotation}°</td>
                <td>
                  <button
                    type="button"
                    className={`carve-btn ${carving ? "on" : ""}`}
                    title={carving ? "Stop carving the rooms under this one" : "Carve the rooms under this one"}
                    onClick={() => (carving ? release(b.id) : carve(b.id))}
                  >
                    {carving ? "Release" : "Carve"}
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
    </div>
  );
}

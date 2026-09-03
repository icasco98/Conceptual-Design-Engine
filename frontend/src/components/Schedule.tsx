import { useMemo } from "react";

import { displayShapes } from "../geometry/carve";
import { polyArea } from "../geometry/poly";
import { clampPositionOnly, liveBoxes, resolveOverlaps } from "../geometry/resolve";
import type { Box } from "../geometry/types";
import { useStore } from "../state/store";

export function Schedule() {
  const boxes = useStore((s) => s.boxes);
  const level = useStore((s) => s.level);
  const envelope = useStore((s) => s.envelope);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const deleteBoxes = useStore((s) => s.deleteBoxes);
  const commitBoxes = useStore((s) => s.commitBoxes);

  const live = useMemo(() => liveBoxes(boxes, level), [boxes, level]);
  const shapes = useMemo(() => displayShapes(live, null), [live]);
  const areaOf = (b: Box) => {
    const s = shapes.find((x) => x.id === b.id);
    return s ? polyArea(s.page) : b.width * b.height;
  };

  const edit = (b: Box, axis: "w" | "h", meters: number) => {
    if (!isFinite(meters) || meters <= 0 || !envelope) return;
    let next: Box;
    if (axis === "w") {
      const w = Math.max(b.minWidth, meters);
      next = { ...b, left: b.left + (b.width - w) / 2, width: w };
    } else {
      const h = Math.max(b.minHeight, meters);
      next = { ...b, top: b.top + (b.height - h) / 2, height: h };
    }
    next = clampPositionOnly(next, envelope);
    const resolved = resolveOverlaps(live.map((x) => (x.id === b.id ? next : x)), b.id, envelope);
    const byId = new Map(resolved.map((x) => [x.id, x]));
    commitBoxes(boxes.map((x) => byId.get(x.id) ?? x));
  };

  return (
    <div className="schedule">
      <h3>Room schedule</h3>
      <p className="muted">Click a row to select it. Edit width and depth here or drag a corner.</p>
      <table>
        <thead>
          <tr>
            <th>Space</th>
            <th>W (m)</th>
            <th>D (m)</th>
            <th>Area</th>
            <th>Rot.</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {live.map((b) => {
            const carved = shapes.find((s) => s.id === b.id)?.carved;
            return (
              <tr
                key={b.id}
                className={selected.includes(b.id) ? "selected" : ""}
                onClick={(e) => {
                  const t = e.target as HTMLElement;
                  if (t.tagName === "INPUT" || t.tagName === "BUTTON") return;
                  select(b.id, e.shiftKey);
                }}
              >
                <td>{b.name}</td>
                <td>
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
                <td>
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
                <td className={carved ? "carved" : ""} title={carved ? "Shaped around a neighbour" : ""}>
                  {areaOf(b).toFixed(1)}
                </td>
                <td>{b.rotation}°</td>
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

/**
 * What the tool knows about the arrangement, along the foot of the window.
 *
 * What is on the current storey, and -- the one message that must never
 * be missed -- which rooms a carve has taken below their minimum size or
 * cut in two. Those rooms also carry a red outline on the plan; here they
 * are named, so a flag off-screen is still seen.
 */
import { useMemo } from "react";

import { displayShapes } from "../geometry/carve";
import { polyArea } from "../geometry/poly";
import { liveBoxes } from "../geometry/snap";
import { IconTick, IconWarn } from "./icons";
import { useStore } from "../state/store";

export function StatusBar() {
  const boxes = useStore((s) => s.boxes);
  const level = useStore((s) => s.level);

  const { spaces, area, flagged } = useMemo(() => {
    const live = liveBoxes(boxes, level);
    const shapes = displayShapes(live);
    const total = shapes.reduce((sum, s) => sum + polyArea(s.page), 0);
    const names = shapes.filter((s) => s.flagged).map((s) => live.find((b) => b.id === s.id)?.name ?? s.id);
    return { spaces: live.length, area: total, flagged: names };
  }, [boxes, level]);

  return (
    <footer className="status">
      <div className="status-line">
        {flagged.length ? (
          <span className="status-item error">
            <IconWarn /> Below minimum after carving: {flagged.join(", ")} — move, resize, or release the carve
          </span>
        ) : (
          <span className="status-item ok">
            <IconTick /> Every room at or above its minimum
          </span>
        )}
        <span className="status-item muted">
          {spaces} {spaces === 1 ? "space" : "spaces"} on this floor · <span className="num">{area.toFixed(1)} m²</span>
        </span>
      </div>
    </footer>
  );
}

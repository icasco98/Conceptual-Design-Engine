/**
 * What the tool knows about the arrangement, along the foot of the window.
 *
 * Nothing checks the plan any more — the access and stacking checks left
 * with the generation pipeline — so for now this reads what is on the
 * current storey. It keeps its place at the foot because it is where the
 * overlap conflicts will be reported once priority carving arrives: the
 * one message that must never be missed is the one saying a room is
 * below its minimum.
 */
import { useMemo } from "react";

import { displayShapes } from "../geometry/carve";
import { polyArea } from "../geometry/poly";
import { liveBoxes } from "../geometry/resolve";
import { IconTick } from "./icons";
import { useStore } from "../state/store";

export function StatusBar() {
  const boxes = useStore((s) => s.boxes);
  const level = useStore((s) => s.level);

  const { spaces, area } = useMemo(() => {
    const live = liveBoxes(boxes, level);
    const shapes = displayShapes(live, null);
    const total = shapes.reduce((sum, s) => sum + polyArea(s.page), 0);
    return { spaces: live.length, area: total };
  }, [boxes, level]);

  return (
    <footer className="status">
      <div className="status-line">
        <span className="status-item ok">
          <IconTick /> {spaces} {spaces === 1 ? "space" : "spaces"} on this floor ·{" "}
          <span className="num">{area.toFixed(1)} m²</span> drawn
        </span>
      </div>
    </footer>
  );
}

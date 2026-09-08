/**
 * What the tool knows about the arrangement, along the foot of the window.
 *
 * What is on the current storey, and -- the messages that must never be
 * missed -- which rooms a carve has taken below their minimum size or cut
 * in two, and which zones sit outside the plot. Both carry a red outline
 * on the plan; here they are named, so a flag off-screen is still seen.
 *
 * With the plot binding, this is also where its coverage is reported: how
 * much of the site the floor you are looking at actually uses, which is
 * the number the boundary exists to make answerable.
 */
import { useMemo } from "react";

import { displayShapes } from "../geometry/carve";
import { outsidePlot } from "../geometry/plot";
import { polyArea } from "../geometry/poly";
import { liveBoxes } from "../geometry/snap";
import { IconTick, IconWarn } from "./icons";
import { useStore } from "../state/store";

export function StatusBar() {
  const boxes = useStore((s) => s.boxes);
  const level = useStore((s) => s.level);
  const autoCarve = useStore((s) => s.autoCarve);
  const plot = useStore((s) => s.plot);

  const { spaces, area, flagged, strays, toPlace } = useMemo(() => {
    const live = liveBoxes(boxes, level);
    const shapes = displayShapes(live, autoCarve);
    const total = shapes.reduce((sum, s) => sum + polyArea(s.page), 0);
    const names = shapes.filter((s) => s.flagged).map((s) => live.find((b) => b.id === s.id)?.name ?? s.id);
    // Every storey's strays, not just this one's: a zone left outside the
    // boundary two floors up is exactly the thing you would not notice.
    const out = outsidePlot(boxes.filter((b) => !b.deleted), plot).map((b) => b.name);
    // Zones from the schedule with a size and no position yet, on this
    // floor: not on the plan, so not in `live` or its area.
    const waiting = boxes.filter((b) => !b.deleted && b.placed === false && b.level === level).length;
    return { spaces: live.length, area: total, flagged: names, strays: out, toPlace: waiting };
  }, [boxes, level, autoCarve, plot]);

  const plotArea = plot.width * plot.depth;

  return (
    <footer className="status">
      <div className="status-line">
        {plot.on && strays.length ? (
          <span className="status-item error">
            <IconWarn /> Outside the plot: {strays.join(", ")} — drag each one in, or make the plot bigger
          </span>
        ) : flagged.length ? (
          <span className="status-item error">
            <IconWarn /> Below minimum after carving: {flagged.join(", ")} — move, resize, or release the carve
          </span>
        ) : (
          <span className="status-item ok">
            <IconTick /> {plot.on ? "Every room inside the plot and at or above its minimum" : "Every room at or above its minimum"}
          </span>
        )}
        <span className="status-item muted">
          {spaces} {spaces === 1 ? "space" : "spaces"} on this floor · <span className="num">{area.toFixed(1)} m²</span>
          {plot.on && plotArea > 0 && (
            <>
              {" of "}
              <span className="num">{plotArea.toFixed(0)} m²</span> plot ·{" "}
              <span className="num">{((area / plotArea) * 100).toFixed(0)}%</span> covered
            </>
          )}
        </span>
        {toPlace > 0 && (
          <span className="status-item muted">
            · <span className="num">{toPlace}</span> {toPlace === 1 ? "zone" : "zones"} to place
          </span>
        )}
      </div>
    </footer>
  );
}

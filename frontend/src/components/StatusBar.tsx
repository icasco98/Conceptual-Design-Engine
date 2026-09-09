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
import { actorRoute, buildCirculationGraph, sharedSegments, type ReachabilityProblem } from "../geometry/circulation";
import { outsidePlot } from "../geometry/plot";
import { polyArea } from "../geometry/poly";
import { collectFindings, TIER_ORDER, type AdjacencyStatus, type TierViolation } from "../geometry/relationships";
import { liveBoxes } from "../geometry/snap";
import { auxiliaryOf, isServiceOf, passableOf, roomTypeInfo, tierOf } from "../rooms";
import type { Box } from "../geometry/types";
import { IconFootprints, IconTick, IconWarn } from "./icons";
import { useStore } from "../state/store";

/** One plain sentence per finding, naming the actual rooms and the
 * actual consequence -- never "tier," "gradient" or "category," so
 * nobody needs to know this tool's own vocabulary to understand what's
 * wrong. Lives here, in the component, the same way `Actors.tsx` keeps
 * `ROLE_LABEL`/`OUT_OF_BOUNDS_LABEL` next to where they're shown rather
 * than in `geometry/`, which hands back structured data and stops there
 * on purpose. */
function tierSentences(violations: TierViolation[], boxesById: Map<string, Box>): string[] {
  return violations.flatMap((v) => {
    const a = boxesById.get(v.roomAId);
    const b = boxesById.get(v.roomBId);
    if (!a || !b) return [];
    const [outer, inner] = TIER_ORDER[v.tierA] < TIER_ORDER[v.tierB] ? [a, b] : [b, a];
    return [`${outer.name} opens straight into ${inner.name}`];
  });
}

function reachabilitySentences(problems: ReachabilityProblem[], boxesById: Map<string, Box>): string[] {
  return problems.flatMap((p) => {
    const room = boxesById.get(p.roomId);
    if (!room) return [];
    const via = p.viaIds.map((id) => boxesById.get(id)?.name).filter((n): n is string => !!n);
    if (via.length) return [`The only way to ${room.name} is through ${via.join(" or ")}`];
    return [`Nothing connects to ${room.name} yet`];
  });
}

function adjacencySentences(rows: AdjacencyStatus[]): string[] {
  return rows
    .filter((r) => !r.ok)
    .map((r) => {
      const a = roomTypeInfo(r.a).label;
      const b = roomTypeInfo(r.b).label;
      return r.relation === "undesired" ? `${a} and ${b} share a wall -- that's usually kept separate` : `${a} and ${b} aren't near each other, though they usually should be`;
    });
}

export function StatusBar() {
  const boxes = useStore((s) => s.boxes);
  const level = useStore((s) => s.level);
  const storeys = useStore((s) => s.storeys);
  const autoCarve = useStore((s) => s.autoCarve);
  const plot = useStore((s) => s.plot);
  const actors = useStore((s) => s.actors);
  const arrows = useStore((s) => s.arrows);
  const showCirculation = useStore((s) => s.showCirculation);

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

  const sharedCount = useMemo(() => {
    if (!showCirculation) return 0;
    const visible = actors.filter((a) => a.visible);
    if (!visible.length) return 0;
    const graph = buildCirculationGraph(boxes, storeys, arrows, autoCarve);
    const routes = visible.map((a) => ({ actorId: a.id, segments: actorRoute(graph, boxes, a.waypoints).segments }));
    return sharedSegments(routes, level).length;
  }, [showCirculation, actors, boxes, storeys, level, arrows, autoCarve]);

  // Every storey at once, the same reasoning as `strays` above: a privacy
  // problem two floors up is exactly the kind of thing a person would not
  // otherwise notice.
  const privacySentences = useMemo(() => {
    const boxesById = new Map(boxes.map((b) => [b.id, b]));
    const findings = collectFindings(boxes, storeys, arrows, autoCarve, passableOf, tierOf, auxiliaryOf, isServiceOf);
    return [
      ...tierSentences(findings.tier, boxesById),
      ...reachabilitySentences(findings.reachability, boxesById),
      ...adjacencySentences(findings.adjacency),
    ];
  }, [boxes, storeys, arrows, autoCarve]);

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
        {showCirculation && sharedCount > 0 && (
          <span className="status-item warning">
            <IconFootprints size={12} /> {sharedCount} shared stretch{sharedCount === 1 ? "" : "es"} of wall on this floor
          </span>
        )}
        {privacySentences.length > 0 && (
          <span className="status-item warning" title={privacySentences.join("\n")}>
            <IconWarn size={12} /> {privacySentences.length} privacy {privacySentences.length === 1 ? "issue" : "issues"}:{" "}
            {privacySentences.slice(0, 2).join("; ")}
            {privacySentences.length > 2 && ` — and ${privacySentences.length - 2} more (hover to see all)`}
          </span>
        )}
      </div>
    </footer>
  );
}

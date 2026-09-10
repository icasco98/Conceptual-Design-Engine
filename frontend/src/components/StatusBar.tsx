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

import { actorRoute, sharedSegments, type ReachabilityProblem } from "../geometry/circulation";
import type { CirculationRatioFinding, CorridorWasteFinding, DeadEndFinding, GapFinding, OverhangFinding, WetStackFinding } from "../geometry/efficiency";
import { footprintCoverage } from "../geometry/footprint";
import { MIN_EXTERIOR_WALL_M, type ProportionFinding, type SingleAspectFinding, type WindowlessFinding } from "../geometry/habitability";
import { buildCirculationGraphMemo, displayShapesForLevelMemo } from "../geometry/memo";
import { outsidePlot } from "../geometry/plot";
import { polyArea } from "../geometry/poly";
import {
  adjacencySeverity,
  collectFindings,
  TIER_ORDER,
  type AdjacencyStatus,
  type DoorClearanceFinding,
  type OwnEntranceProblem,
  type SanitaryDoorProblem,
  type UndersizedDoorwayFinding,
  type StairConnectionProblem,
  type TierViolation,
} from "../geometry/relationships";
import { liveBoxes } from "../geometry/snap";
import { floorLabel, ROOM_FACTS, roomTypeInfo } from "../rooms";
import type { Box } from "../geometry/types";
import { IconFootprints, IconTick, IconWarn } from "./icons";
import { useStore } from "../state/store";

/** One finding, a storey and the plain sentence describing it -- kept
 * apart rather than baked into one string so the list can be sorted by
 * floor before anything is joined for display. Parsing a floor back out
 * of a finished sentence would be fragile; carrying it as data is not. */
interface Finding {
  level: number;
  text: string;
}

/** One plain sentence per finding, naming the actual rooms and the
 * actual consequence -- never "tier," "gradient" or "category," so
 * nobody needs to know this tool's own vocabulary to understand what's
 * wrong. Lives here, in the component, the same way `Actors.tsx` keeps
 * `ROLE_LABEL`/`OUT_OF_BOUNDS_LABEL` next to where they're shown rather
 * than in `geometry/`, which hands back structured data and stops there
 * on purpose. */
function tierFindings(violations: TierViolation[], boxesById: Map<string, Box>): Finding[] {
  return violations.flatMap((v) => {
    const a = boxesById.get(v.roomAId);
    const b = boxesById.get(v.roomBId);
    if (!a || !b) return [];
    const [outer, inner] = TIER_ORDER[v.tierA] < TIER_ORDER[v.tierB] ? [a, b] : [b, a];
    return [{ level: v.level, text: `${outer.name} opens straight into ${inner.name}` }];
  });
}

function reachabilityFindings(problems: ReachabilityProblem[], boxesById: Map<string, Box>): Finding[] {
  return problems.flatMap((p) => {
    const room = boxesById.get(p.roomId);
    if (!room) return [];
    const via = p.viaIds.map((id) => boxesById.get(id)?.name).filter((n): n is string => !!n);
    const text = via.length ? `The only way to ${room.name} is through ${via.join(" or ")}` : `Nothing connects to ${room.name} yet`;
    return [{ level: p.level, text }];
  });
}

function stairConnectionFindings(problems: StairConnectionProblem[], boxesById: Map<string, Box>): Finding[] {
  return problems.flatMap((s) => {
    const stair = boxesById.get(s.stairId);
    const other = boxesById.get(s.otherRoomId);
    if (!stair || !other) return [];
    return [{ level: s.level, text: `${stair.name} opens straight into ${other.name} instead of a hallway or other circulation space` }];
  });
}

/** Two doorways cut into one wall with less than a door's width between
 * them (`doorClearanceProblems`) -- their frames overlap, so one has to
 * move before either can be built. */
function doorClearanceFindings(problems: DoorClearanceFinding[], boxesById: Map<string, Box>): Finding[] {
  return problems.flatMap((p) => {
    const room = boxesById.get(p.roomId);
    const a = boxesById.get(p.throughIdA);
    const b = boxesById.get(p.throughIdB);
    if (!room || !a || !b) return [];
    return [
      {
        level: p.level,
        text: `${room.name}'s doors to ${a.name} and ${b.name} are ${p.separationM.toFixed(2)} m apart in the same wall -- too close for both to be cut`,
      },
    ];
  });
}

/** A room that should open onto the street on its own and does not
 * (`ownEntranceProblems`) -- today, a diwaniya reached only through the
 * family's own front door and hallway. */
function ownEntranceFindings(problems: OwnEntranceProblem[], boxesById: Map<string, Box>): Finding[] {
  return problems.flatMap((p) => {
    const room = boxesById.get(p.roomId);
    if (!room) return [];
    return [{ level: p.level, text: `${room.name} has no street door of its own -- guests can only reach it through the family's own entrance` }];
  });
}

/** A WC opening straight onto a kitchen or dining room
 * (`sanitaryDoorProblems`). Named here as well as counted by
 * `scoreCandidate` on purpose: a hard problem the generator counts but
 * the status bar never mentions would have the tool telling someone
 * their plan is fine while the search says it is not. */
function sanitaryDoorFindings(problems: SanitaryDoorProblem[], boxesById: Map<string, Box>): Finding[] {
  return problems.flatMap((p) => {
    const wc = boxesById.get(p.sanitaryId);
    const room = boxesById.get(p.foodRoomId);
    if (!wc || !room) return [];
    return [{ level: p.level, text: `${wc.name} opens straight into ${room.name} -- a WC needs a hall or lobby between it and a room used for food` }];
  });
}

/** A door drawn across a stretch of shared wall too short to cut a
 * doorway into (`undersizedDoorways`). Worth naming rather than only
 * counting: every other finding downstream treats the two rooms as
 * connected on the strength of this door, so "the plan is fine" and
 * "these rooms do not actually connect" are the same sentence until
 * someone is told which wall it is. */
function undersizedDoorwayFindings(problems: UndersizedDoorwayFinding[], boxesById: Map<string, Box>): Finding[] {
  return problems.flatMap((p) => {
    const a = boxesById.get(p.roomAId);
    const b = boxesById.get(p.roomBId);
    if (!a || !b) return [];
    return [{ level: p.level, text: `${a.name} and ${b.name} share only ${p.wallM.toFixed(2)} m of wall -- too little to fit the door drawn between them` }];
  });
}

/** A sleeping room with effectively no wall facing outside
 * (`habitability.ts`'s `windowlessSleepingRooms`) -- no window is
 * possible there, so no way out of it in a fire. */
function windowlessFindings(problems: WindowlessFinding[], boxesById: Map<string, Box>): Finding[] {
  return problems.flatMap((p) => {
    const room = boxesById.get(p.roomId);
    if (!room) return [];
    const how = p.exteriorM < 0.01 ? "no wall facing outside at all" : `only ${p.exteriorM.toFixed(2)} m of wall facing outside`;
    return [{ level: p.level, text: `${room.name} has ${how} -- a room slept in needs at least ${MIN_EXTERIOR_WALL_M.toFixed(1)} m for a window to escape through` }];
  });
}

/** A wet room on an upper floor with no wet room under it
 * (`efficiency.ts`'s `unstackedWetRooms`) -- its own boxed-in stack to
 * build and to reach later, rather than a share of one. Cost, so a
 * recommendation. */
function wetStackFindings(problems: WetStackFinding[], boxesById: Map<string, Box>): Finding[] {
  return problems.flatMap((p) => {
    const room = boxesById.get(p.roomId);
    return room ? [{ level: p.level, text: `${room.name} sits over dry rooms -- its pipes need a stack of their own instead of sharing one below` }] : [];
  });
}

/** Comfort and usability, not code (`habitability.ts`) -- always a
 * recommendation, never a problem, the same severity a `desired` miss and
 * every efficiency.ts finding already has: the room works, it is just
 * worse to be in than it needs to be. */
function habitabilityRecommendationFindings(
  aspect: SingleAspectFinding[],
  proportion: ProportionFinding[],
  boxesById: Map<string, Box>,
): Finding[] {
  return [
    ...aspect.flatMap((p) => {
      const room = boxesById.get(p.roomId);
      return room ? [{ level: p.level, text: `${room.name} faces outside on one side only -- no through draught, so it holds its heat` }] : [];
    }),
    ...proportion.flatMap((p) => {
      const room = boxesById.get(p.roomId);
      return room ? [{ level: p.level, text: `${room.name} is ${p.aspect.toFixed(1)} times longer than it is wide -- hard to furnish as anything but a corridor` }] : [];
    }),
  ];
}

/** `required` and `undesired` are hard problems: a real requirement
 * unmet, or a real conflict present. `desired` is a softer, "usually a
 * good idea" recommendation -- kept in its own list, not mixed in with
 * the problems, so a person can tell "this must be fixed" apart from
 * "this would help" at a glance rather than reading every sentence to
 * find out which kind it is. `adjacencySeverity` (relationships.ts) is
 * the one place that split is decided, shared with `scoreCandidate` so
 * the two never disagree about which category a row falls into. */
function adjacencyProblemFindings(rows: AdjacencyStatus[]): Finding[] {
  return rows
    .filter((r) => !r.ok && adjacencySeverity(r) === "problem")
    .map((r) => {
      const a = roomTypeInfo(r.a).label;
      const b = roomTypeInfo(r.b).label;
      if (r.relation === "undesired") return { level: r.level, text: `${a} and ${b} share a wall -- that's usually kept separate` };
      // Two different reasons a required pair can fail, worth telling
      // apart: a wall with no door in it reads very differently from two
      // rooms that were never placed near each other at all.
      if (r.touching) return { level: r.level, text: `${a} and ${b} share a wall, but there's no door between them` };
      return { level: r.level, text: `${a} and ${b} aren't near each other at all, though they need to be` };
    });
}

function adjacencyRecommendationFindings(rows: AdjacencyStatus[]): Finding[] {
  return rows
    .filter((r) => !r.ok && adjacencySeverity(r) === "recommendation")
    .map((r) => {
      const a = roomTypeInfo(r.a).label;
      const b = roomTypeInfo(r.b).label;
      return { level: r.level, text: `${a} and ${b} are a long way apart -- usually easier when they're close` };
    });
}

/** A cost/efficiency finding, not a correctness one (geometry/efficiency.ts)
 * -- always a recommendation, never a problem, same as a `desired` miss:
 * the house still works, it just costs more than it needs to. */
function gapFindings(gaps: GapFinding[], boxesById: Map<string, Box>): Finding[] {
  return gaps.flatMap((g) => {
    const a = boxesById.get(g.roomAId);
    const b = boxesById.get(g.roomBId);
    if (!a || !b) return [];
    const cm = Math.round(g.gapM * 100);
    return [{ level: g.level, text: `${a.name} and ${b.name} are ${cm} cm apart -- close enough to share a wall and save the cost of two` }];
  });
}

function circulationRatioFindings(findings: CirculationRatioFinding[]): Finding[] {
  return findings.map((f) => ({
    level: f.level,
    text: `Hallways and landings take up ${Math.round(f.ratio * 100)}% of this floor -- more than usual for a house this size`,
  }));
}

function overhangFindings(findings: OverhangFinding[], boxesById: Map<string, Box>): Finding[] {
  return findings.flatMap((f) => {
    const room = boxesById.get(f.roomId);
    const neighbor = boxesById.get(f.neighborId);
    if (!room || !neighbor) return [];
    const m = f.exposedM.toFixed(1);
    return [{ level: f.level, text: `${room.name}'s wall runs ${m} m past where it meets ${neighbor.name} -- a jog the exterior wall pays for either way` }];
  });
}

function corridorWasteFindings(findings: CorridorWasteFinding[], boxesById: Map<string, Box>): Finding[] {
  return findings.flatMap((f) => {
    const room = boxesById.get(f.roomId);
    if (!room) return [];
    const m = f.wastedM.toFixed(1);
    return [{ level: f.level, text: `${room.name} runs ${m} m past its own doors -- floor a shorter corridor wouldn't need` }];
  });
}

/** The one finding in efficiency.ts that is a hard problem, not a
 * recommendation -- see `deadEndHallways`'s own doc comment for why. */
function deadEndFindings(findings: DeadEndFinding[], boxesById: Map<string, Box>): Finding[] {
  return findings.flatMap((f) => {
    const hallway = boxesById.get(f.hallwayId);
    const room = boxesById.get(f.farRoomId);
    if (!hallway || !room) return [];
    const m = f.distanceM.toFixed(1);
    return [{ level: f.level, text: `${hallway.name} is the only way in or out for ${room.name}, ${m} m away -- too far for just one route` }];
  });
}

/** Every finding, floor by floor -- lowest first, a floor's own findings
 * kept in whichever order they arrived in (stable sort), not scattered
 * across the list in whatever order the four checks happened to run.
 * Returns the flat "Floor G: ..." lines a compact preview wants, and the
 * grouped, floor-headed block a hover tooltip wants, from the one sort. */
function organizeByFloor(findings: Finding[]): { flat: string[]; grouped: string } {
  const sorted = [...findings].sort((a, b) => a.level - b.level);
  const flat = sorted.map((f) => `Floor ${floorLabel(f.level)}: ${f.text}`);
  const grouped: string[] = [];
  let currentLevel: number | null = null;
  for (const f of sorted) {
    if (f.level !== currentLevel) {
      currentLevel = f.level;
      grouped.push(`Floor ${floorLabel(f.level)}:`);
    }
    grouped.push(`  ${f.text}`);
  }
  return { flat, grouped: grouped.join("\n") };
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
    const shapes = displayShapesForLevelMemo(boxes, level, autoCarve);
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
    const graph = buildCirculationGraphMemo(boxes, storeys, arrows, autoCarve);
    const routes = visible.map((a) => ({ actorId: a.id, segments: actorRoute(graph, boxes, a.waypoints).segments }));
    return sharedSegments(routes, level).length;
  }, [showCirculation, actors, boxes, storeys, level, arrows, autoCarve]);

  // Every storey at once, the same reasoning as `strays` above: an issue
  // two floors up is exactly the kind of thing a person would not
  // otherwise notice. Split into hard problems (a real requirement unmet
  // or conflict present -- tier skips, reachability problems, a stair
  // opening onto the wrong room, and a dead-end corridor past the real
  // code limit are always this severity) and soft recommendations (a
  // `desired` miss, an unnecessary gap, an over-ratio hallway, an
  // overhanging wall, a corridor longer than its own doors need -- all
  // correct but costly), so the two never read as equally urgent. Each
  // list is organized floor by floor, not left in whatever order the
  // checks happened to produce them in.
  const { problems, recommendations } = useMemo(() => {
    const boxesById = new Map(boxes.map((b) => [b.id, b]));
    const findings = collectFindings(boxes, storeys, arrows, autoCarve, ROOM_FACTS);
    const hard = [
      ...tierFindings(findings.tier, boxesById),
      ...reachabilityFindings(findings.reachability, boxesById),
      ...stairConnectionFindings(findings.stairConnection, boxesById),
      ...adjacencyProblemFindings(findings.adjacency),
      ...sanitaryDoorFindings(findings.sanitaryDoors, boxesById),
      ...ownEntranceFindings(findings.ownEntrance, boxesById),
      ...undersizedDoorwayFindings(findings.undersizedDoorways, boxesById),
      ...doorClearanceFindings(findings.doorClearance, boxesById),
      ...windowlessFindings(findings.windowless, boxesById),
      ...deadEndFindings(findings.deadEndHallways, boxesById),
    ];
    const soft = [
      ...adjacencyRecommendationFindings(findings.adjacency),
      ...gapFindings(findings.gaps, boxesById),
      ...circulationRatioFindings(findings.circulationRatio),
      ...overhangFindings(findings.overhangs, boxesById),
      ...corridorWasteFindings(findings.corridorWaste, boxesById),
      ...wetStackFindings(findings.wetStacks, boxesById),
      ...habitabilityRecommendationFindings(findings.singleAspect, findings.proportion, boxesById),
    ];
    return { problems: organizeByFloor(hard), recommendations: organizeByFloor(soft) };
  }, [boxes, storeys, arrows, autoCarve]);

  const plotArea = plot.width * plot.depth;
  const coverage = useMemo(() => footprintCoverage(boxes, level, autoCarve, plot), [boxes, level, autoCarve, plot]);

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
              <span className="num">{(coverage * 100).toFixed(0)}%</span> covered
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
        {problems.flat.length > 0 && (
          <span className="status-item error" title={problems.grouped}>
            <IconWarn size={12} /> {problems.flat.length} privacy {problems.flat.length === 1 ? "problem" : "problems"}: {problems.flat.slice(0, 2).join("; ")}
            {problems.flat.length > 2 && ` — and ${problems.flat.length - 2} more (hover to see all, by floor)`}
          </span>
        )}
        {recommendations.flat.length > 0 && (
          <span className="status-item muted" title={recommendations.grouped}>
            {recommendations.flat.length} {recommendations.flat.length === 1 ? "recommendation" : "recommendations"}:{" "}
            {recommendations.flat.slice(0, 2).join("; ")}
            {recommendations.flat.length > 2 && ` — and ${recommendations.flat.length - 2} more (hover to see all, by floor)`}
          </span>
        )}
      </div>
    </footer>
  );
}

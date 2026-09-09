/**
 * Circulation: who walks where.
 *
 * A route is never drawn by hand and never stored as a shape -- it is the
 * shortest walk of a graph of real doors between an actor's waypoints.
 * Move a room, and every actor's route recomputes from wherever it is
 * now; there is no second copy of the plan to keep in step.
 *
 * Two zones sharing a wall are not, on that fact alone, a way through:
 * an edge exists only where a placed door actually sits on that wall
 * (`doorOnWall`). No door, no edge -- not a fainter line, not a
 * softened one, simply nothing there for Dijkstra to find. A plan with
 * no doors yet has no circulation yet either; `suggestArrows`'s own
 * Suggest button is the one-click way to give it some. This is a
 * deliberate reversal of an earlier version, which fell back to a
 * wall's geometric midpoint when no door existed -- that made every
 * touching pair walkable regardless of whether a door was ever placed,
 * which meant a route could be drawn with total confidence through a
 * wall nobody had opened. A tool that shows a route is a tool asserting
 * the route is possible; it must never assert something it does not
 * know to be true.
 *
 * A zone's own outline decides what it touches, not just a plain
 * rectangle's four walls: a rotated box's turned edges, a hand-drawn
 * polygon's own vertices, and the exact boundary a carve leaves behind
 * are all read the same way (doors.ts's `touchingEdges`, fed each
 * zone's post-carve outline via `displayShapes`). That last case is
 * also what connects a zone carved into another with the zone that
 * carved it, without any special-case carve logic here: subtracting one
 * polygon from another leaves their outlines sharing exactly the cut's
 * own edge, and this graph asks the same "do these outlines share a
 * wall" question of every pair regardless of how they came to share it.
 *
 * A zone spanning several storeys (a stair) is the same node on each of
 * them, so it is what lets a route cross from one storey's graph to the
 * next -- there is no separate stair machinery here either.
 *
 * An arrow's own position (arrows.ts) is stored relative to its host's
 * declared shape, not the plan's current drawing, so it can outlive the
 * wall it was placed on: a later carve can shorten or delete that
 * stretch, or simply carve away the neighbour that used to be on its
 * other side, without the arrow itself moving at all. `arrowIsLive`
 * (and `liveArrowIds`, every level at once) is the read-time check for
 * this -- an arrow that fails it is not deleted or moved, only flagged,
 * the same "say so, do not guess" treatment a broken route leg gets.
 *
 * A flagged arrow still has to be drawn somewhere, and its raw
 * `hostId`/`side`/`t` position is no longer trustworthy for that -- it
 * can now sit anywhere the host's declared shape says, including inside
 * whatever other zone has since been drawn over that spot. `frozenAt`
 * (`Arrow`, types.ts) is where it is drawn instead once that happens:
 * its last real position, kept in sync by `syncFrozenArrowPoints` for
 * as long as the door stays real, and left alone the instant it stops
 * being one. A frozen door does not drift as the rest of the plan keeps
 * changing around it -- it stays exactly where it broke until someone
 * moves it or the wall comes back.
 */
import { arrowSegment } from "./arrows";
import { displayShapes } from "./carve";
import { buildTouchGraph, type Touch } from "./doors";
import { pointOnPolyBoundary } from "./poly";
import { centerOf, rectOf } from "./rect";
import { liveBoxes } from "./snap";
import type { ActorRole, Arrow, Box, Point, Poly } from "./types";

const TOUCH_TOL_M = 0.04;
/** How close a placed door must sit to a wall's own run to count as
 * being on it -- generous enough for a door dragged anywhere along a
 * real wall, tight enough not to pick up a door on a different one. The
 * same tolerance decides whether an arrow is still live at all: a door
 * that no longer reads as "on" its wall by this measure is not on it,
 * whether the question is "is there a door here" or "is this door
 * still real." */
const DOOR_ON_WALL_TOL_M = 0.15;

interface CircEdge {
  to: string;
  mid: Point;
  level: number;
  weight: number;
}

export type CirculationGraph = Map<string, CircEdge[]>;

const closeEnough = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

/** Whether a point sits on a wall run, within tolerance -- perpendicular
 * distance from the line, and distance along it from either endpoint,
 * both inside `tol`. General on purpose: a touch is a page-frame
 * segment at whatever angle the two zones actually meet at, not
 * necessarily one of the plan's own x/y axes. */
function pointOnTouch(p: Point, touch: Touch, tol: number): boolean {
  const dx = touch.p2[0] - touch.p1[0];
  const dy = touch.p2[1] - touch.p1[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const vx = p[0] - touch.p1[0];
  const vy = p[1] - touch.p1[1];
  const along = vx * ux + vy * uy;
  const across = vx * uy - vy * ux;
  return Math.abs(across) <= tol && along >= -tol && along <= len + tol;
}

/** Where a placed interior door between `a` and `b` actually sits on
 * this particular wall run. A door on any other wall of either host (an
 * exterior door, or one of the host's other walls) is not this wall's
 * door, and is skipped. */
function doorOnWall(arrows: Arrow[], a: Box, b: Box, touch: Touch): Point | null {
  for (const arrow of arrows) {
    if (arrow.kind && arrow.kind !== "interior") continue;
    const host = arrow.hostId === a.id ? a : arrow.hostId === b.id ? b : null;
    if (!host) continue;
    const [p1, p2] = arrowSegment(host, arrow);
    const mid: Point = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
    if (pointOnTouch(mid, touch, DOOR_ON_WALL_TOL_M)) return mid;
  }
  return null;
}

/** A storey's zones, their current post-carve outlines, and which of
 * them touch -- the one computation `buildCirculationGraph` and
 * `liveArrowIds` both need, so they read the same geometry rather than
 * two slightly different copies of it. Exported for `relationships.ts`,
 * which needs the same per-storey touch graph for its own, separate
 * question (do two room types that should be adjacent actually share a
 * wall) -- reusing this rather than recomputing carve and touch data a
 * second way. */
export function levelTouchData(boxes: Box[], level: number, autoCarve: boolean) {
  const live = liveBoxes(boxes, level);
  const shapes = displayShapes(live, autoCarve);
  const polyById = new Map(shapes.map((s) => [s.id, s.page]));
  const touchGraph = buildTouchGraph(polyById, TOUCH_TOL_M);
  return { polyById, touchGraph };
}

/** Every pair of zones with a real door between them, on any storey,
 * both directions. Built fresh from the current arrangement -- there is
 * nothing here to keep in step by hand. `buildTouchGraph`, fed each
 * zone's actual post-carve outline (`displayShapes`, so `autoCarve`
 * reads the same way here as it does on the plan), still supplies the
 * candidate pairs -- nothing without a shared wall could have a door on
 * one -- but sharing a wall is no longer enough on its own: only a pair
 * `doorOnWall` actually finds a door for becomes an edge. A carve can
 * leave two zones sharing more than one separate wall run, so every run
 * between a pair is checked; the first one with a door on it wins. */
export function buildCirculationGraph(boxes: Box[], storeys: number, arrows: Arrow[], autoCarve: boolean): CirculationGraph {
  const graph: CirculationGraph = new Map();
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const push = (from: Box, to: Box, mid: Point, level: number) => {
    const weight = Math.hypot(
      from.left + from.width / 2 - (to.left + to.width / 2),
      from.top + from.height / 2 - (to.top + to.height / 2),
    );
    const list = graph.get(from.id) ?? [];
    list.push({ to: to.id, mid, level, weight });
    graph.set(from.id, list);
  };
  for (let level = 0; level < storeys; level++) {
    const levelArrows = arrows.filter((a) => a.level === level);
    const { touchGraph } = levelTouchData(boxes, level, autoCarve);
    const byPair = new Map<string, { from: Box; to: Box; touches: Touch[] }>();
    for (const [fromId, edges] of touchGraph) {
      const from = byId.get(fromId);
      if (!from) continue;
      for (const edge of edges) {
        // The graph already carries both directions of every pair; walk
        // each unordered pair once, from whichever id sorts first.
        if (fromId > edge.to) continue;
        const to = byId.get(edge.to);
        if (!to) continue;
        const pairKey = `${fromId}|${edge.to}`;
        const entry = byPair.get(pairKey) ?? { from, to, touches: [] };
        entry.touches.push(edge.touch);
        byPair.set(pairKey, entry);
      }
    }
    for (const { from, to, touches } of byPair.values()) {
      let door: Point | null = null;
      for (const touch of touches) {
        door = doorOnWall(levelArrows, from, to, touch);
        if (door) break;
      }
      if (!door) continue;
      push(from, to, door, level);
      push(to, from, door, level);
    }
  }
  return graph;
}

/** Whether one placed arrow is still, right now, a real door: an
 * interior one needs a real touch -- some neighbour whose current
 * outline actually meets the host's, right there -- and an exterior one
 * needs to still sit on the host's own current outline. Neither is
 * about where the arrow was put; both are about what is true of the
 * plan this instant. A carve can take either away without the arrow
 * moving at all: it can shorten or delete the very stretch of wall a
 * door sits on, or -- just as real a loss -- leave the host's wall
 * itself untouched while carving away the neighbour that used to be on
 * its other side. Either way the door stops being real, and this is the
 * one place that notices. */
export function arrowIsLive(arrow: Arrow, host: Box, touchesForHost: Touch[], hostOutline: Poly): boolean {
  const [p1, p2] = arrowSegment(host, arrow);
  const mid: Point = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  if (arrow.kind && arrow.kind !== "interior") {
    return pointOnPolyBoundary(hostOutline, mid, DOOR_ON_WALL_TOL_M);
  }
  return touchesForHost.some((touch) => pointOnTouch(mid, touch, DOOR_ON_WALL_TOL_M));
}

/** Every arrow on the plan that `arrowIsLive` still stands behind, right
 * now. Nothing here is stored -- like a route, it is recomputed from
 * wherever the zones, carves and other arrows currently are, so a stale
 * door starts and stops being flagged the instant the plan changes
 * under it, with no separate state to fall out of step. */
export function liveArrowIds(boxes: Box[], storeys: number, arrows: Arrow[], autoCarve: boolean): Set<string> {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const live = new Set<string>();
  for (let level = 0; level < storeys; level++) {
    const { polyById, touchGraph } = levelTouchData(boxes, level, autoCarve);
    for (const arrow of arrows) {
      if (arrow.level !== level) continue;
      const host = byId.get(arrow.hostId);
      if (!host) continue;
      const outline = polyById.get(host.id);
      if (!outline) continue;
      const touches = (touchGraph.get(host.id) ?? []).map((e) => e.touch);
      if (arrowIsLive(arrow, host, touches, outline)) live.add(arrow.id);
    }
  }
  return live;
}

/** Every arrow, with `frozenAt` brought up to date: still exactly where
 * it draws today for anything `arrowIsLive` still stands behind, and
 * left completely untouched for anything it does not. Call this after
 * every edit that could move a wall -- the store does, once, centrally,
 * rather than each of the many actions that could invalidate a door
 * having to remember to. The moment a door goes stale, whatever is
 * written here is its last real position; nothing after that moment
 * ever overwrites it again, until the door is real once more (moved
 * back onto a wall, or replaced by hand). */
export function syncFrozenArrowPoints(boxes: Box[], arrows: Arrow[], autoCarve: boolean): Arrow[] {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const perLevel = new Map<number, ReturnType<typeof levelTouchData>>();
  const dataFor = (level: number) => {
    let d = perLevel.get(level);
    if (!d) {
      d = levelTouchData(boxes, level, autoCarve);
      perLevel.set(level, d);
    }
    return d;
  };
  let changed = false;
  const out = arrows.map((arrow) => {
    const host = byId.get(arrow.hostId);
    if (!host) return arrow;
    const { polyById, touchGraph } = dataFor(arrow.level);
    const outline = polyById.get(host.id);
    if (!outline) return arrow;
    const touches = (touchGraph.get(host.id) ?? []).map((e) => e.touch);
    if (!arrowIsLive(arrow, host, touches, outline)) return arrow;
    const segment = arrowSegment(host, arrow);
    if (arrow.frozenAt && closeEnough(arrow.frozenAt[0], segment[0]) && closeEnough(arrow.frozenAt[1], segment[1])) return arrow;
    changed = true;
    return { ...arrow, frozenAt: segment };
  });
  return changed ? out : arrows;
}

interface PathResult {
  nodes: string[];
  /** `edges[k]` connects `nodes[k]` to `nodes[k + 1]`. */
  edges: { mid: Point; level: number }[];
}

/** Dijkstra rather than a plain breadth-first walk: a room with several
 * neighbours (a landing, a kitchen) can have more than one way round, and
 * the shortest one is not always the fewest doors. */
function shortestPath(graph: CirculationGraph, fromId: string, toId: string): PathResult | null {
  if (fromId === toId) return { nodes: [fromId], edges: [] };
  const dist = new Map<string, number>([[fromId, 0]]);
  const prev = new Map<string, { parent: string; mid: Point; level: number }>();
  const visited = new Set<string>();
  const queue = new Set<string>([fromId]);
  while (queue.size) {
    let u: string | null = null;
    let best = Infinity;
    for (const id of queue) {
      const d = dist.get(id) ?? Infinity;
      if (d < best) {
        best = d;
        u = id;
      }
    }
    if (u === null) break;
    queue.delete(u);
    if (u === toId) break;
    visited.add(u);
    for (const edge of graph.get(u) ?? []) {
      if (visited.has(edge.to)) continue;
      const nd = best + edge.weight;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        prev.set(edge.to, { parent: u, mid: edge.mid, level: edge.level });
        queue.add(edge.to);
      }
    }
  }
  if (!prev.has(toId)) return null;
  const nodes = [toId];
  const edges: { mid: Point; level: number }[] = [];
  let cur = toId;
  while (cur !== fromId) {
    const p = prev.get(cur);
    if (!p) return null;
    edges.push({ mid: p.mid, level: p.level });
    nodes.push(p.parent);
    cur = p.parent;
  }
  nodes.reverse();
  edges.reverse();
  return { nodes, edges };
}

export interface RouteSegment {
  level: number;
  /** Plan-frame meters: room centre, door, room centre, ... */
  pts: Point[];
}

/** One leg of an actor's route -- between two consecutive waypoints --
 * that no sequence of real doors connects. Named rather than merely
 * absent: a route that stops short of where it was asked to go should
 * say why, the same way a flagged carve is named in the status bar
 * instead of just looking wrong. */
export interface BrokenLeg {
  fromId: string;
  toId: string;
}

export interface ActorRouteResult {
  segments: RouteSegment[];
  broken: BrokenLeg[];
}

/** An actor's route, chained through its waypoints in order and split
 * into one segment per storey it crosses. A waypoint that no longer
 * exists is skipped outright, the same way a stray reference anywhere
 * else in the tool is; a waypoint that still exists but that no run of
 * real doors reaches from the one before it is kept, and that leg is
 * reported in `broken` instead of being drawn -- there is a real
 * difference between "this stop is gone" and "this stop exists but you
 * cannot actually walk to it," and only one of those is this function's
 * business to hide. */
export function actorRoute(graph: CirculationGraph, boxes: Box[], waypoints: string[]): ActorRouteResult {
  const boxesById = new Map(boxes.map((b) => [b.id, b]));
  const present = waypoints.filter((id) => boxesById.has(id));
  const centerOfId = (id: string) => centerOf(rectOf(boxesById.get(id)!));
  const segments: RouteSegment[] = [];
  const broken: BrokenLeg[] = [];
  let cur: RouteSegment | null = null;
  const pushPoint = (level: number, pt: Point) => {
    if (cur && cur.level === level) {
      const last = cur.pts[cur.pts.length - 1];
      if (!last || !closeEnough(last, pt)) cur.pts.push(pt);
    } else {
      cur = { level, pts: [pt] };
      segments.push(cur);
    }
  };
  for (let i = 0; i < present.length - 1; i++) {
    const leg = shortestPath(graph, present[i], present[i + 1]);
    if (!leg) {
      broken.push({ fromId: present[i], toId: present[i + 1] });
      continue;
    }
    const startLevel = leg.edges[0]?.level ?? boxesById.get(leg.nodes[0])!.level;
    pushPoint(startLevel, centerOfId(leg.nodes[0]));
    for (let k = 0; k < leg.edges.length; k++) {
      pushPoint(leg.edges[k].level, leg.edges[k].mid);
      pushPoint(leg.edges[k].level, centerOfId(leg.nodes[k + 1]));
    }
  }
  return { segments: segments.filter((s) => s.pts.length >= 2), broken };
}

export function routeLength(segments: RouteSegment[]): number {
  let total = 0;
  for (const seg of segments) {
    for (let i = 1; i < seg.pts.length; i++) {
      total += Math.hypot(seg.pts[i][0] - seg.pts[i - 1][0], seg.pts[i][1] - seg.pts[i - 1][1]);
    }
  }
  return total;
}

/** Every category a role has no business being waypointed into. Kept on
 * category (`zoneOf`), deliberately not on tier: this is a *role*
 * question (who is this room's category off-limits to) not a *gradient*
 * one (does a door skip a buffer), and the two axes genuinely disagree in
 * places -- the kitchen is Private *tier* (no stranger's door should open
 * straight onto it) but stays Shared *category* (a servant's whole job
 * can be standing in it). Using tier here would have wrongly barred
 * household staff from the kitchen. `served` is never checked -- the
 * household goes anywhere in its own house. `guest` and `servant`/
 * `exterior` share the one rule already here: stay out of the private
 * (`category_a`) rooms. `diwaniya_guest` is stricter again -- received in
 * the one room built for that (`category_d`) and has no business anywhere
 * else the plan sorts rooms into, private or shared or service alike. */
const FORBIDDEN: Record<ActorRole, (zone: string) => boolean> = {
  served: () => false,
  guest: (zone) => zone === "category_a",
  servant: (zone) => zone === "category_a",
  exterior: (zone) => zone === "category_a",
  diwaniya_guest: (zone) => zone !== "category_d",
};

/** True once any waypoint an actor visits falls in a category its role
 * has no business in (`FORBIDDEN`, above) -- the one check circulation
 * makes automatically, because it is the one a house's own room
 * categories (rooms.ts, palette.ts) already answer without anyone
 * having to say so twice. */
export function outOfBounds(role: ActorRole, waypoints: string[], boxesById: Map<string, Box>, zoneOf: (roomType: string) => string): boolean {
  const forbidden = FORBIDDEN[role];
  return waypoints.some((id) => {
    const b = boxesById.get(id);
    return !!b && forbidden(zoneOf(b.roomType));
  });
}

export interface ReachabilityProblem {
  roomId: string;
  /** "unreachable": no run of real doors gets here from any exterior
   * door at all. "through_room": a run exists, but every one of them
   * passes through a room that is not passable -- named in `viaIds`,
   * nearest first, the same "say what's actually wrong" treatment a
   * broken route leg already gets. */
  kind: "unreachable" | "through_room";
  viaIds: string[];
}

/** Every room the plan fails to serve properly, walking out from *every*
 * exterior door at once -- a household's main entry and a diwaniya's own
 * street door are both legitimate starting points, so this is not single-
 * entry reachability with one exception carved out for the diwaniya; it
 * is the general case, and a house with only a main entry is just the
 * one-root version of it.
 *
 * The walk may only continue on from a passable room (rooms.ts's
 * `passable`) -- a corridor obviously, a bedroom or a bathroom never. A
 * room reached only through non-passable rooms is reported with what
 * stands in the way, so the answer names the actual problem ("the only
 * way to Bedroom 2 is through the Garage") rather than just declaring the
 * plan wrong. An exterior door's own host is always a valid room to reach
 * (and to continue walking from), whether or not its room type is itself
 * passable -- entering the house at all is not blocked by what kind of
 * room the entry happens to be.
 *
 * Nothing here is about privacy tiers -- a diwaniya guest being confined
 * to Public rooms is `outOfBounds`'s question, asked only of the
 * waypoints someone actually assigns an actor. This check asks a
 * different, structural question that applies to everyone: can this room
 * be reached by *some* run of real doors at all, without demanding a walk
 * through somewhere nobody should be walking through. */
export function reachabilityProblems(
  boxes: Box[],
  storeys: number,
  arrows: Arrow[],
  autoCarve: boolean,
  passableOf: (roomType: string) => boolean,
): ReachabilityProblem[] {
  const graph = buildCirculationGraph(boxes, storeys, arrows, autoCarve);
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const roots = new Set(arrows.filter((a) => a.kind === "exterior-main" || a.kind === "exterior-side").map((a) => a.hostId));
  const reached = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const cur = queue.shift()!;
    const box = byId.get(cur);
    const canContinue = roots.has(cur) || (!!box && passableOf(box.roomType));
    if (!canContinue) continue;
    for (const edge of graph.get(cur) ?? []) {
      if (reached.has(edge.to)) continue;
      reached.add(edge.to);
      queue.push(edge.to);
    }
  }
  const problems: ReachabilityProblem[] = [];
  for (let level = 0; level < storeys; level++) {
    for (const b of liveBoxes(boxes, level)) {
      if (b.level !== level) continue; // count a tall zone once, on its own base storey
      if (reached.has(b.id)) continue;
      const neighborIds = (graph.get(b.id) ?? []).map((e) => e.to);
      const blockers = neighborIds.filter((id) => {
        const nb = byId.get(id);
        return !!nb && !roots.has(id) && !passableOf(nb.roomType);
      });
      if (neighborIds.length && blockers.length) {
        problems.push({ roomId: b.id, kind: "through_room", viaIds: blockers.slice(0, 2) });
      } else {
        problems.push({ roomId: b.id, kind: "unreachable", viaIds: [] });
      }
    }
  }
  return problems;
}

/** Segments, from any number of actors, that share a stretch of wall on
 * the same storey -- the corridor pinch points and kitchen crossings a
 * plan drawing does not otherwise show. Two segments share a stretch when
 * an edge of one lands on the same two points as an edge of the other, in
 * either direction; near enough (1 mm) stands for exactly, since a wall
 * midpoint computed twice can land a hair apart. */
export function sharedSegments(routes: { actorId: string; segments: RouteSegment[] }[], level: number): { a: Point; b: Point; actorIds: string[] }[] {
  const key = (p: Point) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
  const byEdge = new Map<string, { a: Point; b: Point; actorIds: Set<string> }>();
  for (const { actorId, segments } of routes) {
    for (const seg of segments) {
      if (seg.level !== level) continue;
      for (let i = 1; i < seg.pts.length; i++) {
        const [p, q] = [seg.pts[i - 1], seg.pts[i]];
        const forward = `${key(p)}|${key(q)}`;
        const backward = `${key(q)}|${key(p)}`;
        const existing = byEdge.get(forward) ?? byEdge.get(backward);
        if (existing) existing.actorIds.add(actorId);
        else byEdge.set(forward, { a: p, b: q, actorIds: new Set([actorId]) });
      }
    }
  }
  return [...byEdge.values()].filter((e) => e.actorIds.size >= 2).map((e) => ({ a: e.a, b: e.b, actorIds: [...e.actorIds] }));
}

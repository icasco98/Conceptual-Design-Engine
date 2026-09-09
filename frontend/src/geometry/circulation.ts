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
 */
import { arrowSegment } from "./arrows";
import { displayShapes } from "./carve";
import { buildTouchGraph, type Touch } from "./doors";
import { centerOf, rectOf } from "./rect";
import { liveBoxes } from "./snap";
import type { ActorRole, Arrow, Box, Point } from "./types";

const TOUCH_TOL_M = 0.04;
/** How close a placed door must sit to a wall's own run to count as
 * being on it -- generous enough for a door dragged anywhere along a
 * real wall, tight enough not to pick up a door on a different one. */
const DOOR_ON_WALL_TOL_M = 0.15;

interface CircEdge {
  to: string;
  mid: Point;
  level: number;
  weight: number;
}

export type CirculationGraph = Map<string, CircEdge[]>;

/** Where a placed interior door between `a` and `b` actually sits on
 * this particular wall run, checked against the run's own two endpoints
 * rather than just its midpoint -- a door near one end of a long wall
 * still counts, whatever angle the wall itself runs at. A door on any
 * other wall of either host (an exterior door, or one of the host's
 * other walls) is not this wall's door, and is skipped. */
function doorOnWall(arrows: Arrow[], a: Box, b: Box, touch: Touch): Point | null {
  const dx = touch.p2[0] - touch.p1[0];
  const dy = touch.p2[1] - touch.p1[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  for (const arrow of arrows) {
    if (arrow.kind && arrow.kind !== "interior") continue;
    const host = arrow.hostId === a.id ? a : arrow.hostId === b.id ? b : null;
    if (!host) continue;
    const [p1, p2] = arrowSegment(host, arrow);
    const mx = (p1[0] + p2[0]) / 2;
    const my = (p1[1] + p2[1]) / 2;
    // Distance along the wall run from its first endpoint, and
    // perpendicular to it -- the general form of the old x/y split,
    // which only worked because a plain wall always ran along one axis.
    const vx = mx - touch.p1[0];
    const vy = my - touch.p1[1];
    const along = vx * ux + vy * uy;
    const across = vx * uy - vy * ux;
    if (Math.abs(across) > DOOR_ON_WALL_TOL_M) continue;
    if (along < -DOOR_ON_WALL_TOL_M || along > len + DOOR_ON_WALL_TOL_M) continue;
    return [mx, my];
  }
  return null;
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
    const live = liveBoxes(boxes, level);
    const levelArrows = arrows.filter((a) => a.level === level);
    const shapes = displayShapes(live, autoCarve);
    const polyById = new Map(shapes.map((s) => [s.id, s.page]));
    const touchGraph = buildTouchGraph(polyById, TOUCH_TOL_M);
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

const closeEnough = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

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

/** Every category a role has no business being waypointed into. `served`
 * is never checked -- the household goes anywhere in its own house.
 * `guest` and `servant`/`exterior` share the one rule already here:
 * stay out of the private (`category_a`) rooms. `majlis_guest` is
 * stricter again -- a reception guest is received in the one room built
 * for that (`category_d`) and has no business anywhere else the plan
 * sorts rooms into, private or shared or service alike. */
const FORBIDDEN: Record<ActorRole, (zone: string) => boolean> = {
  served: () => false,
  guest: (zone) => zone === "category_a",
  servant: (zone) => zone === "category_a",
  exterior: (zone) => zone === "category_a",
  majlis_guest: (zone) => zone !== "category_d",
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

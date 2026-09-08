/**
 * Circulation: who walks where.
 *
 * A route is never drawn by hand and never stored as a shape -- it is the
 * shortest walk of the touching graph between an actor's waypoints, the
 * same graph `suggestArrows` already walks from the entry (arrows.ts).
 * Move a room, and every actor's route recomputes from wherever it is
 * now; there is no second copy of the plan to keep in step.
 *
 * Only axis-aligned, unrotated rectangles take part in the graph -- the
 * same limit `suggestArrows` already has, for the same reason: a rotated
 * or round zone has no wall to share, so there is nothing to walk across.
 *
 * A route is threaded through the wall's own midpoint between each pair
 * of rooms, not a straight line between their centres, so it reads as
 * someone going through a doorway rather than cutting through a corner.
 * A zone spanning several storeys (a stair) is the same node on each of
 * them, so it is what lets a route cross from one storey's graph to the
 * next -- there is no separate stair machinery here either.
 */
import { touchingEdge } from "./doors";
import { centerOf, rectOf } from "./rect";
import { liveBoxes } from "./snap";
import type { ActorRole, Box, Point } from "./types";

const TOUCH_TOL_M = 0.04;

interface CircEdge {
  to: string;
  mid: Point;
  level: number;
  weight: number;
}

export type CirculationGraph = Map<string, CircEdge[]>;

function plain(b: Box): boolean {
  return b.shape === "rect" && !b.rotation;
}

/** Every pair of zones sharing a wall, on any storey, both directions.
 * Built fresh from the current arrangement -- there is nothing here to
 * keep in step by hand. */
export function buildCirculationGraph(boxes: Box[], storeys: number): CirculationGraph {
  const graph: CirculationGraph = new Map();
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
    const live = liveBoxes(boxes, level).filter(plain);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const touch = touchingEdge(rectOf(live[i]), rectOf(live[j]), TOUCH_TOL_M);
        if (!touch) continue;
        push(live[i], live[j], touch.mid, level);
        push(live[j], live[i], touch.mid, level);
      }
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
  /** Plan-frame meters: room centre, wall midpoint, room centre, ... */
  pts: Point[];
}

const closeEnough = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

/** An actor's route, chained through its waypoints in order and split
 * into one segment per storey it crosses. A waypoint that no longer
 * exists, or that has no path from the one before it (the plan is in two
 * disconnected pieces, say), breaks only that one leg -- the rest of the
 * route still draws, the same way a stray door arrow does not stop the
 * others from being suggested. */
export function actorRoute(graph: CirculationGraph, boxes: Box[], waypoints: string[]): RouteSegment[] {
  const boxesById = new Map(boxes.map((b) => [b.id, b]));
  const present = waypoints.filter((id) => boxesById.has(id));
  const centerOfId = (id: string) => centerOf(rectOf(boxesById.get(id)!));
  const segments: RouteSegment[] = [];
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
    if (!leg) continue;
    const startLevel = leg.edges[0]?.level ?? boxesById.get(leg.nodes[0])!.level;
    pushPoint(startLevel, centerOfId(leg.nodes[0]));
    for (let k = 0; k < leg.edges.length; k++) {
      pushPoint(leg.edges[k].level, leg.edges[k].mid);
      pushPoint(leg.edges[k].level, centerOfId(leg.nodes[k + 1]));
    }
  }
  return segments.filter((s) => s.pts.length >= 2);
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

/** True once any waypoint a `servant` or `exterior` actor visits is a
 * private (`category_a`) zone -- the one check that matters most in a
 * house that already sorts every room into served, shared and service
 * (rooms.ts, palette.ts): staff and trades are not meant to have a
 * reason to be in a bedroom. Guests and the household itself are never
 * flagged; where they go is their own business. */
export function crossesPrivate(role: ActorRole, waypoints: string[], boxesById: Map<string, Box>, zoneOf: (roomType: string) => string): boolean {
  if (role !== "servant" && role !== "exterior") return false;
  return waypoints.some((id) => {
    const b = boxesById.get(id);
    return !!b && zoneOf(b.roomType) === "category_a";
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

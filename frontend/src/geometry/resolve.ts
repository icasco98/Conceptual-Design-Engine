/**
 * Moving boxes: envelope clamp, grid and gap snapping, and the push that
 * happens only where a room cannot give the space up (see carve.ts).
 * Everything here returns new Box objects; nothing is mutated.
 */
import { carvePlanFor, CarveContext } from "./carve";
import { boxesTrulyIntersect, effectiveRectOf, obbOf, obbPenetration, rectOf } from "./rect";
import { GAP_SNAP_M, GRID_M, OVERLAP_EPS, type Box, type Envelope } from "./types";

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

export function snapToGrid(v: number): number {
  return Math.round(v / GRID_M) * GRID_M;
}

export function liveBoxes(boxes: Box[], level: number): Box[] {
  return boxes.filter((b) => !b.deleted && b.level === level);
}

/** Translate-only envelope clamp on the box's effective (rotation-aware)
 * rect. A box pushed against the setback line stops at it; nothing but
 * the owner resizes a room. */
export function clampPositionOnly(b: Box, env: Envelope): Box {
  const eff = effectiveRectOf(b);
  let dLeft = 0;
  let dTop = 0;
  if (eff.left < env.left) dLeft = env.left - eff.left;
  else if (eff.left + eff.width > env.right) dLeft = env.right - (eff.left + eff.width);
  if (eff.top < env.top) dTop = env.top - eff.top;
  else if (eff.top + eff.height > env.bottom) dTop = env.bottom - (eff.top + eff.height);
  if (!dLeft && !dTop) return b;
  return { ...b, left: b.left + dLeft, top: b.top + dTop };
}

/** Sub-meter gap to the nearest facing neighbour along one axis, if any. */
export function findNearestGapDelta(el: Box, live: Box[], axis: "x" | "y"): number | null {
  const r = rectOf(el);
  let bestGap = Infinity;
  let bestDelta: number | null = null;
  for (const other of live) {
    if (other.id === el.id) continue;
    const o = rectOf(other);
    if (axis === "x") {
      const yOverlap = Math.min(r.top + r.height, o.top + o.height) - Math.max(r.top, o.top);
      if (yOverlap <= 0) continue;
      const gapRight = o.left - (r.left + r.width);
      if (gapRight > 0.02 && gapRight < GAP_SNAP_M && gapRight < bestGap) {
        bestGap = gapRight;
        bestDelta = gapRight;
      }
      const gapLeft = r.left - (o.left + o.width);
      if (gapLeft > 0.02 && gapLeft < GAP_SNAP_M && gapLeft < bestGap) {
        bestGap = gapLeft;
        bestDelta = -gapLeft;
      }
    } else {
      const xOverlap = Math.min(r.left + r.width, o.left + o.width) - Math.max(r.left, o.left);
      if (xOverlap <= 0) continue;
      const gapDown = o.top - (r.top + r.height);
      if (gapDown > 0.02 && gapDown < GAP_SNAP_M && gapDown < bestGap) {
        bestGap = gapDown;
        bestDelta = gapDown;
      }
      const gapUp = r.top - (o.top + o.height);
      if (gapUp > 0.02 && gapUp < GAP_SNAP_M && gapUp < bestGap) {
        bestGap = gapUp;
        bestDelta = -gapUp;
      }
    }
  }
  return bestDelta;
}

export function snapToNearbyNeighbors(el: Box, live: Box[]): Box {
  let out = el;
  const dx = findNearestGapDelta(out, live, "x");
  if (dx !== null) out = { ...out, left: out.left + dx };
  const dy = findNearestGapDelta(out, live, "y");
  if (dy !== null) out = { ...out, top: out.top + dy };
  return out;
}

/** Broad phase: is anything touching at all? */
export function anyBoxesOverlap(live: Box[]): boolean {
  const rects = live.map(effectiveRectOf);
  for (let a = 0; a < live.length; a++) {
    const ra = rects[a];
    for (let b = a + 1; b < live.length; b++) {
      const rb = rects[b];
      if (
        ra.left + OVERLAP_EPS < rb.left + rb.width &&
        rb.left + OVERLAP_EPS < ra.left + ra.width &&
        ra.top + OVERLAP_EPS < rb.top + rb.height &&
        rb.top + OVERLAP_EPS < ra.top + ra.height &&
        boxesTrulyIntersect(live[a], live[b])
      )
        return true;
    }
  }
  return false;
}

/** Only where nobody can give the space up does anything move: the other
 * room, one step, once. The pinned box is never touched, corridors never
 * move, and a push never triggers another. Returns the level's live boxes
 * with any moves applied. */
export function resolveOverlaps(live: Box[], pinnedId: string | null, env: Envelope): Box[] {
  if (!anyBoxesOverlap(live)) return live;
  const ctx = new CarveContext(pinnedId);
  const byId = new Map(live.map((b) => [b.id, b]));
  const movedAlready = new Set<string>();
  for (const stuckOriginal of live) {
    const current = byId.get(stuckOriginal.id)!;
    const plan = carvePlanFor(current, [...byId.values()], ctx);
    for (const otherOriginal of plan.refused) {
      const stuck = byId.get(current.id)!;
      const other = byId.get(otherOriginal.id)!;
      const mover = stuck.id === pinnedId ? other : stuck;
      if (mover.id === pinnedId) continue;
      if (mover.kind === "corridor") continue;
      if (movedAlready.has(mover.id)) continue;
      const against = mover.id === stuck.id ? other : stuck;
      const mtv = obbPenetration(obbOf(mover), obbOf(against));
      if (!mtv) continue;
      const moved = clampPositionOnly({ ...mover, left: mover.left + mtv[0], top: mover.top + mtv[1] }, env);
      byId.set(moved.id, moved);
      movedAlready.add(moved.id);
    }
  }
  return live.map((b) => byId.get(b.id)!);
}

/** Can these boxes hold the angles they now have? Every room a turning
 * box runs into either absorbs the bite or the turn is refused. */
export function rotationIsAllowed(targets: Box[], live: Box[]): boolean {
  const ctx = new CarveContext(targets.length === 1 ? targets[0].id : null);
  const targetIds = new Set(targets.map((t) => t.id));
  for (const el of targets) {
    for (const other of live) {
      if (other.id === el.id || targetIds.has(other.id)) continue;
      if (!boxesTrulyIntersect(el, other)) continue;
      if (!ctx.chooseBiteVictim(el, other)) return false;
    }
  }
  return true;
}

/**
 * Rotations the owner asked for in words.
 *
 * The angle arrives from the chat as a request, and is applied here through
 * exactly the rules a hand rotation goes through -- including, crucially,
 * the same 5-degree steps. Dragging the handle to 45 works because each
 * step resolves before the next is tried, so neighbours are pushed clear a
 * little at a time; jumping straight to 45 asks every neighbour to give way
 * at once and is refused almost every time. Stepping is not a detail of the
 * gesture, it is why the gesture succeeds.
 *
 * A turn that cannot go the whole way goes as far as it can and says so,
 * which is also what the handle does under your hand.
 *
 * A refusal is reported rather than swallowed. Dragging the handle and
 * watching a room spring back at least tells you something happened; a
 * sentence in a chat that quietly does nothing tells you the tool is
 * broken.
 */
import { clampPositionOnly, resolveOverlaps, rotationIsAllowed } from "./resolve";
import { liveBoxes } from "./resolve";
import type { Box, Envelope } from "./types";

/** The rotate handle steps in 5 degrees; a typed angle should not be able
 *  to reach an angle a hand cannot. */
const STEP = 5;

export interface RotationRequest {
  room_name: string;
  degrees: number;
}

export interface RotationOutcome {
  boxes: Box[];
  /** Room names turned, the angle they hold, and the angle asked for. */
  applied: { name: string; degrees: number; wanted: number }[];
  /** Room names that could not turn at all. */
  refused: string[];
  /** Room names the program does not contain. */
  unknown: string[];
}

export function normaliseAngle(degrees: number): number {
  const snapped = Math.round(degrees / STEP) * STEP;
  return ((snapped % 360) + 360) % 360;
}

/** The shortest way round from one angle to another, in degrees, signed. */
export function shortestTurn(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

/**
 * Apply every request that fits, leave the rest untouched, and say which
 * was which. Levels are handled one at a time because a room only ever
 * collides with the storey it is on -- and because the stair, which sits on
 * several, must end up at one angle on all of them.
 */
export function applyRotations(
  boxes: Box[],
  requests: RotationRequest[],
  envelope: Envelope,
  storeys: number,
): RotationOutcome {
  const applied: RotationOutcome["applied"] = [];
  const refused: string[] = [];
  const unknown: string[] = [];
  let current = boxes;

  for (const request of requests) {
    const wanted = normaliseAngle(request.degrees);
    const name = request.room_name.trim().toLowerCase();
    const targets = current.filter((b) => !b.deleted && b.name.trim().toLowerCase() === name);
    if (targets.length === 0) {
      unknown.push(request.room_name);
      continue;
    }

    const targetIds = new Set(targets.map((b) => b.id));
    const start = normaliseAngle(targets[0].rotation);
    const total = shortestTurn(start, wanted);
    const steps = Math.round(Math.abs(total) / STEP);
    const direction = Math.sign(total);

    let held = current;
    let heldAngle = start;
    for (let i = 1; i <= steps; i++) {
      const angle = normaliseAngle(start + direction * STEP * i);
      let attempt = held.map((b) =>
        targetIds.has(b.id) ? clampPositionOnly({ ...b, rotation: angle }, envelope) : b,
      );
      // Every storey the room is on has to accept the step, so a stair
      // never ends up turned upstairs and square down.
      let fits = true;
      for (let lv = 0; lv < storeys; lv++) {
        const live = liveBoxes(attempt, lv);
        const turning = live.filter((b) => targetIds.has(b.id));
        if (turning.length === 0) continue;
        if (!rotationIsAllowed(turning, live)) {
          fits = false;
          break;
        }
        const settled = resolveOverlaps(live, turning.length === 1 ? turning[0].id : null, envelope);
        const byId = new Map(settled.map((b) => [b.id, b]));
        attempt = attempt.map((b) => byId.get(b.id) ?? b);
      }
      if (!fits) break;
      held = attempt;
      heldAngle = angle;
    }

    if (heldAngle === start && steps > 0) {
      refused.push(targets[0].name);
      continue;
    }
    current = held;
    applied.push({ name: targets[0].name, degrees: heldAngle, wanted });
  }

  return { boxes: current, applied, refused, unknown };
}

/** What to tell the owner, in one sentence, or nothing when there is
 *  nothing worth saying. */
export function rotationReport(outcome: RotationOutcome): string | null {
  const parts: string[] = [];
  for (const a of outcome.applied) {
    if (a.degrees !== a.wanted) {
      parts.push(
        `${a.name} turned as far as ${a.degrees}° — past that its corners run into rooms that ` +
          `can't give up any more space.`,
      );
    } else if (a.degrees === 0) {
      parts.push(`Straightened ${a.name}.`);
    } else {
      parts.push(`Turned ${a.name} to ${a.degrees}°.`);
    }
  }
  if (outcome.refused.length) {
    const list = outcome.refused.join(" and ");
    parts.push(
      `${list} can't turn at all where it is — a turned room reaches past the corners of the space ` +
        `it had, and its neighbours are already at their minimum. Move it somewhere with more room ` +
        `around it first.`,
    );
  }
  for (const u of outcome.unknown) {
    parts.push(`There's no room called "${u}" in this project.`);
  }
  return parts.length ? parts.join(" ") : null;
}

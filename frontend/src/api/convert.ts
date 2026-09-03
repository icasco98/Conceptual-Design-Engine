/**
 * The one place the two coordinate frames meet.
 *
 * Python's site frame: meters, y UP from the site's back edge, so the
 * street (front) edge sits at y = site depth.  The canvas's plan frame
 * (geometry/types.ts): meters, y DOWN from the site's front edge, so the
 * street runs along the top of the drawing.  Same x.
 */
import type { Box, Envelope } from "../geometry/types";
import type { ArrangementIn, EnvelopeOut, LevelOut, Project } from "./types";

export function siteSize(project: Project): { width: number; depth: number } {
  return { width: project.site.width_m ?? 0, depth: project.site.depth_m ?? 0 };
}

export function envelopeToPlan(env: EnvelopeOut, project: Project): Envelope {
  const { width, depth } = siteSize(project);
  return {
    left: env.left_setback_m,
    right: width - env.right_setback_m,
    top: env.front_setback_m,
    bottom: depth - env.back_setback_m,
  };
}

/** A packed building -> canvas boxes for every level. */
export function buildingToBoxes(levels: LevelOut[], project: Project): Box[] {
  const { depth } = siteSize(project);
  const out: Box[] = [];
  for (const level of levels) {
    for (const room of level.rooms) {
      const rect = {
        left: room.x_m,
        top: depth - (room.y_m + room.depth_m),
        width: room.width_m,
        height: room.depth_m,
      };
      out.push({
        id: `room:${level.level}:${room.name}`,
        name: room.name,
        kind: "room",
        roomType: room.room_type,
        isEntry: room.is_entry,
        level: level.level,
        ...rect,
        minWidth: room.min_width_m,
        minHeight: room.min_depth_m,
        rotation: 0,
        deleted: false,
        initial: rect,
      });
    }
    level.corridors.forEach((c, i) => {
      const rect = { left: c.x_m, top: depth - (c.y_m + c.depth_m), width: c.width_m, height: c.depth_m };
      out.push({
        id: `corridor:${level.level}:${i}`,
        name: level.corridors.length > 1 ? `Hallway ${i + 1}` : "Hallway",
        kind: "corridor",
        roomType: "hallway",
        isEntry: false,
        level: level.level,
        ...rect,
        minWidth: c.min_width_m,
        minHeight: c.min_depth_m,
        rotation: 0,
        deleted: false,
        initial: rect,
      });
    });
  }
  return out;
}

/** Canvas boxes -> what /api/check and a saved project take. */
export function boxesToArrangement(boxes: Box[], project: Project): ArrangementIn {
  const { depth } = siteSize(project);
  const toSite = (b: Box) => ({
    level: b.level,
    x_m: b.left,
    y_m: depth - (b.top + b.height),
    width_m: b.width,
    depth_m: b.height,
    rotation_deg: b.rotation,
    deleted: b.deleted,
  });
  return {
    boxes: boxes
      .filter((b) => b.kind === "room")
      .map((b) => ({ name: b.name, room_type: b.roomType, is_entry: b.isEntry, ...toSite(b) })),
    corridors: boxes.filter((b) => b.kind === "corridor").map(toSite),
  };
}

/** A saved arrangement -> canvas boxes, keeping the recommendation's
 * minimums (which the arrangement doesn't carry). */
export function arrangementToBoxes(arrangement: ArrangementIn, project: Project, recommended: Box[]): Box[] {
  const { depth } = siteSize(project);
  const byId = new Map(recommended.map((b) => [b.id, b]));
  const out: Box[] = [];
  for (const b of arrangement.boxes) {
    const id = `room:${b.level}:${b.name}`;
    const base = byId.get(id);
    const rect = { left: b.x_m, top: depth - (b.y_m + b.depth_m), width: b.width_m, height: b.depth_m };
    out.push({
      id,
      name: b.name,
      kind: "room",
      roomType: b.room_type,
      isEntry: b.is_entry,
      level: b.level,
      ...rect,
      minWidth: base?.minWidth ?? Math.min(rect.width, 1.0),
      minHeight: base?.minHeight ?? Math.min(rect.height, 1.0),
      rotation: b.rotation_deg,
      deleted: b.deleted,
      initial: base?.initial ?? rect,
    });
  }
  const perLevel = new Map<number, number>();
  for (const c of arrangement.corridors) {
    const i = perLevel.get(c.level) ?? 0;
    perLevel.set(c.level, i + 1);
    const id = `corridor:${c.level}:${i}`;
    const base = byId.get(id);
    const rect = { left: c.x_m, top: depth - (c.y_m + c.depth_m), width: c.width_m, height: c.depth_m };
    out.push({
      id,
      name: base?.name ?? "Hallway",
      kind: "corridor",
      roomType: "hallway",
      isEntry: false,
      level: c.level,
      ...rect,
      minWidth: project.hallway_width_m,
      minHeight: project.hallway_width_m,
      rotation: c.rotation_deg,
      deleted: c.deleted,
      initial: base?.initial ?? rect,
    });
  }
  return out;
}

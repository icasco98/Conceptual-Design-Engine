/** The zoning colours. A room's zone is fixed by its type (rooms.ts). */
import type { CategoryKey } from "./api/types";
import { zoneOf } from "./rooms";

export const CATEGORY_COLORS: Record<CategoryKey, string> = {
  category_a: "#4A6E96",
  category_b: "#C58A3E",
  category_c: "#6E8C74",
};

export const CORRIDOR_FILL = "#FCFCFB";
export const STAIR_FILL = "#7A6A93";

/** Rooms are washed, not flooded: line weight carries the drawing. */
export const CATEGORY_WASH = 0.17;

/** The drawing's own ink, shared by the plan and the 3D view. */
export const INK = {
  sheet: "#FCFCFB",
  site: "#B9BCB6",
  room: "#4A4E4C",
  footprint: "#151817",
  label: "#151817",
  labelSub: "#7C8079",
  dim: "#7C8079",
} as const;

export function fillFor(roomType: string, kind: "room" | "corridor"): string {
  if (kind === "corridor") return CORRIDOR_FILL;
  if (roomType === "stair") return STAIR_FILL;
  return CATEGORY_COLORS[zoneOf(roomType)];
}

export function zoneFill(zone: CategoryKey): string {
  return CATEGORY_COLORS[zone];
}

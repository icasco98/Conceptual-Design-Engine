/** Mirrors src/palette.py. Category keys come from the layout plan. */
import type { CategoryKey } from "./api/types";

export const CATEGORY_COLORS: Record<CategoryKey, string> = {
  category_a: "#4A6E96",
  category_b: "#C58A3E",
  category_c: "#6E8C74",
};

export const CORRIDOR_FILL = "#FCFCFB";
export const STAIR_FILL = "#7A6A93";
export const UNCATEGORISED = "#8E959B";

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
  street: "#8C3B32",
  setback: "#A79654",
} as const;

export function fillFor(roomType: string, kind: "room" | "corridor", category: CategoryKey | undefined): string {
  if (kind === "corridor") return CORRIDOR_FILL;
  if (roomType === "stair") return STAIR_FILL;
  return category ? CATEGORY_COLORS[category] : UNCATEGORISED;
}

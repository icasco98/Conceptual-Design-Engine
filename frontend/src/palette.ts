/** Mirrors src/palette.py. Category keys come from the layout plan. */
import type { CategoryKey } from "./api/types";

export const CATEGORY_COLORS: Record<CategoryKey, string> = {
  category_a: "#2a78d6",
  category_b: "#eb6834",
  category_c: "#1baf7a",
};

export const CORRIDOR_FILL = "#e9e6dc";
export const STAIR_FILL = "#8a6ad6";
export const UNCATEGORISED = "#9a9a9a";

export function fillFor(roomType: string, kind: "room" | "corridor", category: CategoryKey | undefined): string {
  if (kind === "corridor") return CORRIDOR_FILL;
  if (roomType === "stair") return STAIR_FILL;
  return category ? CATEGORY_COLORS[category] : UNCATEGORISED;
}

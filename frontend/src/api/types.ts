/** Wire shapes for the thin backend (api/main.py): health, and saved
 *  layouts. The layout itself is the canvas's own boxes, stored as-is. */
import type { Arrow, Box, Plot } from "../geometry/types";

export type CategoryKey = "category_a" | "category_b" | "category_c";

export interface ProjectSummary {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

/** What a saved layout holds. Plain plan-frame boxes: no conversion, no
 *  second copy of the truth. */
export interface LayoutBody {
  boxes: Box[];
  arrows: Arrow[];
  storeys: number;
  /** The site boundary. Optional: layouts saved before the plot existed
   *  do not carry one, and open with it off. */
  plot?: Plot;
}

export interface SavedProject extends ProjectSummary, LayoutBody {}

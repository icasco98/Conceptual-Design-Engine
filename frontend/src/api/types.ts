/** Wire shapes for the thin backend (api/main.py): health, and saved
 *  layouts. The layout itself is the canvas's own boxes, stored as-is. */
import type { Actor, Arrow, Box, Plot } from "../geometry/types";

/** category_a = private, category_b = shared, category_c = service,
 *  category_d = reception -- a room for a guest the household has not
 *  invited into its own life, only into one room built for that purpose
 *  (a Gulf majlis or diwaniya is the clearest case, not the only one). */
export type CategoryKey = "category_a" | "category_b" | "category_c" | "category_d";

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
  /** Who walks the plan. Optional: layouts saved before circulation
   *  existed do not carry any, and open with none. */
  actors?: Actor[];
  /** The shape of this save, for `migrateLayout` (state/store.ts) to read
   *  against. Optional: absent means whatever the oldest shape was, since
   *  no layout carried a number before this field existed either. */
  version?: number;
}

export interface SavedProject extends ProjectSummary, LayoutBody {}

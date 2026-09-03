/** Wire shapes, mirroring src/models.py and api/serialize.py. */

export type EdgePosition = "front" | "back" | "left" | "right";

export interface SiteEdge {
  position: EdgePosition;
  adjacency: "street" | "neighbor";
  setback_override_m: number | null;
}

export interface Site {
  width_m: number | null;
  depth_m: number | null;
  rotation_deg: number | null;
  edges: SiteEdge[];
}

export interface Room {
  name: string;
  room_type: string;
  count: number;
  explicit_width_m: number | null;
  explicit_depth_m: number | null;
  is_entry: boolean;
  priority_notes: string | null;
  levels: number[];
}

export interface Project {
  owner: string | null;
  site: Site;
  setbacks: { street_m: number; neighbor_m: number };
  max_building_height_m: number;
  hallway_width_m: number;
  storeys: number;
  storey_height_m: number;
  rooms: Room[];
  priorities: string[];
  notes: string | null;
}

export type CategoryKey = "category_a" | "category_b" | "category_c";

export interface LayoutPlan {
  grouping_label: string;
  category_labels: Record<CategoryKey, string>;
  assignments: { room_name: string; category: CategoryKey }[];
  placement_order: string[];
  rationale: string;
}

export interface EnvelopeOut {
  valid: boolean;
  width_m: number;
  depth_m: number;
  area_m2: number;
  front_setback_m: number;
  back_setback_m: number;
  left_setback_m: number;
  right_setback_m: number;
}

export interface BoxOut {
  name: string;
  base_name: string;
  room_type: string;
  is_entry: boolean;
  level: number;
  x_m: number;
  y_m: number;
  width_m: number;
  depth_m: number;
  min_width_m: number;
  min_depth_m: number;
}

export interface CorridorOut {
  x_m: number;
  y_m: number;
  width_m: number;
  depth_m: number;
  min_width_m: number;
  min_depth_m: number;
}

export interface LevelOut {
  level: number;
  rooms: BoxOut[];
  corridors: CorridorOut[];
  footprint: [number, number][];
  circulation_edges: [[number, number], [number, number]][];
}

export interface Issue {
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface AccessProblem {
  room_name: string;
  kind: string;
  via: string[];
  message: string;
}

export interface LayoutOut {
  envelope: EnvelopeOut | null;
  issues: Issue[];
  building: { levels: LevelOut[] } | null;
  access_problems: AccessProblem[];
  stacking_issues: Issue[];
  notes: string;
  circulation_ratio: number;
  placement_order: string[];
}

export interface BoxIn {
  name: string;
  room_type: string;
  level: number;
  x_m: number;
  y_m: number;
  width_m: number;
  depth_m: number;
  is_entry: boolean;
  rotation_deg: number;
  deleted: boolean;
}

export interface CorridorIn {
  level: number;
  x_m: number;
  y_m: number;
  width_m: number;
  depth_m: number;
  rotation_deg: number;
  deleted: boolean;
}

export interface ArrangementIn {
  boxes: BoxIn[];
  corridors: CorridorIn[];
}

export interface CheckOut {
  access_problems: AccessProblem[];
  stacking_issues: Issue[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatOut {
  assistant_message: string;
  explanation: string | null;
  project: Project;
  layout_plan: LayoutPlan | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface SavedProject extends ProjectSummary {
  project: Project;
  layout_plan: LayoutPlan | null;
  arrangement: ArrangementIn | null;
  history: ChatMessage[];
}

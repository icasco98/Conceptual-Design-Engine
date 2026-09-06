/**
 * The single source of truth for what is on the canvas.
 *
 * The 2D canvas, the 3D view, the schedule and the status bar all read
 * from here and nothing else. The arrangement lives here, in plan-frame
 * meters, and every edit goes through these actions. Nothing outside the
 * browser generates or checks it: the backend only keeps saved layouts.
 */
import { create } from "zustand";

import { api } from "../api/client";
import type { ProjectSummary } from "../api/types";
import type { Box } from "../geometry/types";
import { SAMPLE_STOREYS, sampleBoxes } from "../sample";

/** What the 3D pane draws: coloured zones per room, or one grey volume. */
export type MassingMode = "zones" | "mass";

export interface State {
  boxes: Box[];
  /** What Reset returns to: the sample, or the layout as it was loaded. */
  recommended: Box[];
  storeys: number;
  level: number;
  selected: string[];
  busy: string | null;
  error: string | null;
  showGrid: boolean;
  massing: MassingMode;
  showGhost: boolean;
  savedId: string | null;
  savedName: string;
  projects: ProjectSummary[];

  boot: () => Promise<void>;
  setBoxes: (boxes: Box[]) => void;
  commitBoxes: (boxes: Box[]) => void;
  select: (id: string | null, additive?: boolean) => void;
  deleteBoxes: (ids: string[]) => void;
  resetLayout: () => void;
  setLevel: (level: number) => void;
  setMassing: (massing: MassingMode) => void;
  toggleGrid: () => void;
  toggleGhost: () => void;
  refreshProjects: () => Promise<void>;
  saveProject: (name: string) => Promise<void>;
  loadProject: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  newProject: () => void;
  clearError: () => void;
}

/** The stair is one rectangle on every level it connects. Whatever
 * happened to it on one level happens to it on the others. */
function syncStairs(boxes: Box[], changedIds: Set<string>): Box[] {
  const changedStairs = boxes.filter((b) => changedIds.has(b.id) && b.roomType === "stair");
  if (!changedStairs.length) return boxes;
  return boxes.map((b) => {
    if (b.roomType !== "stair") return b;
    const source = changedStairs.find((s) => s.name === b.name && s.id !== b.id);
    if (!source) return b;
    return { ...b, left: source.left, top: source.top, width: source.width, height: source.height, rotation: source.rotation, deleted: source.deleted };
  });
}

export const useStore = create<State>((set, get) => ({
  boxes: [],
  recommended: [],
  storeys: SAMPLE_STOREYS,
  level: 0,
  selected: [],
  busy: null,
  error: null,
  showGrid: false,
  massing: "zones",
  showGhost: true,
  savedId: null,
  savedName: "",
  projects: [],

  async boot() {
    get().newProject();
    // The saved-layout list is the only thing that needs the backend. The
    // editor itself has already opened on the sample by this point, so a
    // missing backend (plain `vite dev`, say) costs nothing but this list.
    try {
      await api.health();
      await get().refreshProjects();
    } catch {
      /* no backend: the editor still works, there is just nowhere to save */
    }
  },

  newProject() {
    const boxes = sampleBoxes();
    set({ boxes, recommended: boxes, storeys: SAMPLE_STOREYS, selected: [], level: 0, savedId: null, savedName: "" });
  },

  /** Mid-gesture: every frame. No stair sync. */
  setBoxes(boxes) {
    set({ boxes });
  },

  /** Gesture over: stairs mirrored across levels. */
  commitBoxes(boxes) {
    const before = new Map(get().boxes.map((b) => [b.id, b]));
    const changed = new Set(boxes.filter((b) => before.get(b.id) !== b).map((b) => b.id));
    set({ boxes: syncStairs(boxes, changed) });
  },

  select(id, additive = false) {
    if (id === null) {
      set({ selected: [] });
      return;
    }
    const selected = get().selected;
    if (additive) {
      set({ selected: selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id] });
    } else if (!selected.includes(id) || selected.length > 1) {
      set({ selected: [id] });
    }
  },

  deleteBoxes(ids) {
    const idSet = new Set(ids);
    get().commitBoxes(get().boxes.map((b) => (idSet.has(b.id) ? { ...b, deleted: true } : b)));
    set({ selected: get().selected.filter((s) => !idSet.has(s)) });
  },

  resetLayout() {
    set({ boxes: get().recommended, selected: [] });
  },

  setLevel(level) {
    set({ level, selected: [] });
  },
  setMassing(massing) {
    set({ massing });
  },
  toggleGrid() {
    set({ showGrid: !get().showGrid });
  },
  toggleGhost() {
    set({ showGhost: !get().showGhost });
  },

  async refreshProjects() {
    try {
      set({ projects: await api.listProjects() });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  async saveProject(name) {
    const { boxes, storeys, savedId } = get();
    const body = { name, boxes, storeys };
    try {
      const saved = savedId ? await api.updateProject(savedId, body) : await api.createProject(body);
      set({ savedId: saved.id, savedName: saved.name });
      await get().refreshProjects();
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  async loadProject(id) {
    set({ busy: "Loading…" });
    try {
      const saved = await api.getProject(id);
      set({
        boxes: saved.boxes,
        recommended: saved.boxes,
        storeys: saved.storeys,
        level: Math.min(get().level, Math.max(0, saved.storeys - 1)),
        selected: [],
        savedId: saved.id,
        savedName: saved.name,
      });
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: null });
    }
  },

  async deleteProject(id) {
    try {
      await api.deleteProject(id);
      if (get().savedId === id) set({ savedId: null, savedName: "" });
      await get().refreshProjects();
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  clearError() {
    set({ error: null });
  },
}));

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
import { carveWith, releaseCarve } from "../geometry/carve";
import { liveBoxes } from "../geometry/snap";
import type { Box, BoxShape } from "../geometry/types";
import { roomTypeInfo } from "../rooms";
import { SAMPLE_STOREYS, sampleBoxes } from "../sample";

/** What the 3D pane draws: coloured zones per room, or one grey volume. */
export type MassingMode = "zones" | "mass";

/** What a drag on empty sheet does. `select` rubber-bands a selection,
 * `pan` moves the view, `rect` and `circle` draw a new zone. */
export type Tool = "select" | "pan" | "rect" | "circle";

export interface State {
  boxes: Box[];
  /** What Reset returns to: the sample, or the layout as it was loaded. */
  recommended: Box[];
  storeys: number;
  level: number;
  selected: string[];
  tool: Tool;
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
  selectMany: (ids: string[], additive?: boolean) => void;
  /** A new zone drawn on the current storey. Returns its id. */
  addBox: (shape: BoxShape, left: number, top: number, width: number, height: number) => string;
  /** A schedule edit: name, type, floor, rotation, size. */
  updateBox: (id: string, patch: Partial<Box>) => void;
  deleteBoxes: (ids: string[]) => void;
  /** The box cuts every room it sits over, on its own storey. */
  carve: (id: string) => void;
  /** The box stops cutting anything. */
  release: (id: string) => void;
  resetLayout: () => void;
  setLevel: (level: number) => void;
  setTool: (tool: Tool) => void;
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

let nextZone = 1;

/** Layouts saved by earlier versions lack the newer fields. */
function normalise(b: Partial<Box> & Box): Box {
  return { ...b, shape: b.shape ?? "rect", levelTo: b.levelTo ?? b.level, carvedBy: b.carvedBy ?? [] };
}

export const useStore = create<State>((set, get) => ({
  boxes: [],
  recommended: [],
  storeys: SAMPLE_STOREYS,
  level: 0,
  selected: [],
  tool: "select",
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

  /** Mid-gesture: every frame. */
  setBoxes(boxes) {
    set({ boxes });
  },

  /** Gesture over. One entry point for every committed edit, so anything
   * that must happen on every edit happens here. */
  commitBoxes(boxes) {
    set({ boxes });
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

  selectMany(ids, additive = false) {
    const current = additive ? get().selected : [];
    set({ selected: [...current, ...ids.filter((id) => !current.includes(id))] });
  },

  addBox(shape, left, top, width, height) {
    const level = get().level;
    const info = roomTypeInfo("other");
    const id = `zone:${Date.now().toString(36)}:${nextZone}`;
    const rect = { left, top, width, height };
    const box: Box = {
      id,
      name: `Zone ${nextZone++}`,
      kind: "room",
      shape,
      roomType: "other",
      isEntry: false,
      level,
      levelTo: level,
      ...rect,
      minWidth: info.minWidth,
      minHeight: info.minHeight,
      rotation: 0,
      carvedBy: [],
      deleted: false,
      initial: rect,
    };
    set({ boxes: [...get().boxes, box], selected: [id] });
    return id;
  },

  updateBox(id, patch) {
    set({
      boxes: get().boxes.map((b) => {
        if (b.id !== id) return b;
        let next = { ...b, ...patch };
        if (patch.roomType && patch.roomType !== b.roomType) {
          const info = roomTypeInfo(patch.roomType);
          next = { ...next, minWidth: info.minWidth, minHeight: info.minHeight, kind: patch.roomType === "hallway" ? "corridor" : "room" };
        }
        if (patch.level !== undefined && patch.levelTo === undefined) {
          // Moving a room to another floor keeps a span's height.
          next = { ...next, levelTo: patch.level + (b.levelTo - b.level) };
        }
        return next;
      }),
    });
  },

  deleteBoxes(ids) {
    const idSet = new Set(ids);
    get().commitBoxes(get().boxes.map((b) => (idSet.has(b.id) ? { ...b, deleted: true } : b)));
    set({ selected: get().selected.filter((s) => !idSet.has(s)) });
  },

  carve(id) {
    const boxes = get().boxes;
    const carver = boxes.find((b) => b.id === id);
    if (!carver) return;
    // A box spanning several storeys carves on each of them.
    let out = boxes;
    for (let lv = carver.level; lv <= carver.levelTo; lv++) {
      const settled = carveWith(carver, liveBoxes(out, lv));
      const byId = new Map(settled.map((b) => [b.id, b]));
      out = out.map((b) => byId.get(b.id) ?? b);
    }
    set({ boxes: out });
  },

  release(id) {
    set({ boxes: releaseCarve(id, get().boxes) });
  },

  resetLayout() {
    set({ boxes: get().recommended, selected: [] });
  },

  setLevel(level) {
    set({ level, selected: [] });
  },
  setTool(tool) {
    set({ tool });
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
      const boxes = saved.boxes.map(normalise);
      set({
        boxes,
        recommended: boxes,
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

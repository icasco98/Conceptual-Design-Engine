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
import { nearestWallPoint, newArrowId, suggestArrows } from "../geometry/arrows";
import { carveWith, releaseCarve } from "../geometry/carve";
import { clampGroup, settleInPlot } from "../geometry/plot";
import { isOpenToBelow, liveBoxes } from "../geometry/snap";
import { touchSelected } from "../geometry/touch";
import type { Arrow, Box, BoxShape, Plot, Point } from "../geometry/types";
import { roomTypeInfo } from "../rooms";
import { DEFAULT_PLOT, DEFAULT_PRIORITY, SAMPLE_STOREYS, STOREY_HEIGHT_M, sampleBoxes, storeysSpanned } from "../sample";

/** What undo restores. The camera, the selection and the toggles are not
 * in it: undo is for the drawing, not for where you were looking. */
interface Snapshot {
  boxes: Box[];
  arrows: Arrow[];
  storeys: number;
  /** Resizing the plot, or switching it on, is an edit to the drawing
   * like any other: it changes where zones may be, so it belongs in the
   * same history as moving one. */
  plot: Plot;
}

/** How many steps back you can go. */
const HISTORY_MAX = 60;

/** What the 3D pane draws: coloured zones per room, or one grey volume. */
export type MassingMode = "zones" | "mass";

/** What a drag on empty sheet does. `select` rubber-bands a selection,
 * `pan` moves the view, `rect` and `circle` draw a new zone, `arrow`
 * puts a door arrow on the wall you click. */
export type Tool = "select" | "pan" | "rect" | "circle" | "arrow";

export interface State {
  boxes: Box[];
  arrows: Arrow[];
  /** What Reset returns to: the sample, or the layout as it was loaded. */
  recommended: Box[];
  recommendedArrows: Arrow[];
  storeys: number;
  /** The site boundary. While `plot.on`, no gesture may take a zone
   * across it (geometry/plot.ts). */
  plot: Plot;
  /** What Reset returns the boundary to. */
  recommendedPlot: Plot;
  level: number;
  selected: string[];
  /** The one arrow selected, if any. Zones and arrows select separately. */
  selectedArrow: string | null;
  tool: Tool;
  busy: string | null;
  error: string | null;
  showGrid: boolean;
  massing: MassingMode;
  /** The outline of the storey below, and of the one above. */
  showGhost: boolean;
  showAbove: boolean;
  /** Dragging a zone in the 3D view moves it; off, the drag orbits. */
  moveIn3D: boolean;
  /** A zone is carved by anything it overlaps that outranks it. */
  autoCarve: boolean;
  past: Snapshot[];
  future: Snapshot[];
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
  /** Move every selected zone to touch its nearest neighbour (touch.ts). */
  touchSelected: () => void;
  /** A door arrow on `hostId`'s wall nearest the page point. */
  addArrow: (hostId: string, at: Point) => void;
  moveArrow: (id: string, at: Point) => void;
  flipArrow: (id: string) => void;
  deleteArrow: (id: string) => void;
  selectArrow: (id: string | null) => void;
  /** Propose arrows for zones that have none yet (arrows.ts). */
  suggestArrows: () => void;
  resetLayout: () => void;
  /** Record the drawing as it stands, before something changes it. Every
   * discrete action does this itself; a gesture calls it as it starts. */
  remember: () => void;
  undo: () => void;
  redo: () => void;
  /** Change the boundary: its size, its position, or whether it binds.
   * Zones already outside are never moved by this -- they are flagged
   * (geometry/plot.ts, rule 3). */
  setPlot: (patch: Partial<Plot>) => void;
  togglePlot: () => void;
  addStorey: () => void;
  /** Remove the top storey, if nothing is up there. */
  removeStorey: () => void;
  setLevel: (level: number) => void;
  setTool: (tool: Tool) => void;
  setMassing: (massing: MassingMode) => void;
  toggleGrid: () => void;
  toggleGhost: () => void;
  toggleAbove: () => void;
  toggleMoveIn3D: () => void;
  toggleAutoCarve: () => void;
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
  const levelTo = b.levelTo ?? b.level;
  const heightM = b.heightM ?? (levelTo - b.level + 1) * STOREY_HEIGHT_M;
  return {
    ...b,
    shape: b.shape ?? "rect",
    carvedBy: b.carvedBy ?? [],
    priority: b.priority ?? DEFAULT_PRIORITY,
    heightM,
    levelTo: b.level + storeysSpanned(heightM) - 1,
  };
}

/** The storeys a set of boxes needs: at least what the layout says, and
 * enough for the tallest zone to be seen on every storey it reaches. */
function storeysFor(boxes: Box[], atLeast: number): number {
  return Math.max(atLeast, ...boxes.filter((b) => !b.deleted).map((b) => b.levelTo + 1));
}

export const useStore = create<State>((set, get) => ({
  boxes: [],
  arrows: [],
  recommended: [],
  recommendedArrows: [],
  storeys: SAMPLE_STOREYS,
  plot: DEFAULT_PLOT,
  recommendedPlot: DEFAULT_PLOT,
  level: 0,
  selected: [],
  selectedArrow: null,
  tool: "select",
  busy: null,
  error: null,
  showGrid: false,
  massing: "zones",
  showGhost: true,
  showAbove: false,
  moveIn3D: false,
  autoCarve: false,
  past: [],
  future: [],
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
    get().remember();
    const boxes = sampleBoxes();
    // The sample's arrows are its suggested ones: one door per room.
    let arrows: Arrow[] = [];
    for (let lv = 0; lv < SAMPLE_STOREYS; lv++) arrows = [...arrows, ...suggestArrows(liveBoxes(boxes, lv), arrows, lv)];
    set({
      boxes,
      arrows,
      recommended: boxes,
      recommendedArrows: arrows,
      storeys: SAMPLE_STOREYS,
      plot: DEFAULT_PLOT,
      recommendedPlot: DEFAULT_PLOT,
      selected: [],
      selectedArrow: null,
      level: 0,
      savedId: null,
      savedName: "",
    });
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
      set({ selected: selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id], selectedArrow: null });
    } else if (!selected.includes(id) || selected.length > 1) {
      set({ selected: [id], selectedArrow: null });
    } else {
      set({ selectedArrow: null });
    }
  },

  selectMany(ids, additive = false) {
    const current = additive ? get().selected : [];
    set({ selected: [...current, ...ids.filter((id) => !current.includes(id))], selectedArrow: null });
  },

  addBox(shape, left, top, width, height) {
    get().remember();
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
      heightM: STOREY_HEIGHT_M,
      priority: DEFAULT_PRIORITY,
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
    get().remember();
    const boxes = get().boxes.map((b) => {
      if (b.id !== id) return b;
      let next = { ...b, ...patch };
      if (patch.roomType && patch.roomType !== b.roomType) {
        const info = roomTypeInfo(patch.roomType);
        next = { ...next, minWidth: info.minWidth, minHeight: info.minHeight, kind: patch.roomType === "hallway" ? "corridor" : "room" };
      }
      // The storeys a zone reaches follow from its height and its floor.
      next = { ...next, levelTo: next.level + storeysSpanned(next.heightM) - 1 };
      return next;
    });
    // A size or an angle typed here is held inside the plot exactly as a
    // drag would be: the schedule must not be a way around the boundary.
    const plot = get().plot;
    const before = get().boxes.find((b) => b.id === id);
    const settled = before ? boxes.map((b) => (b.id === id ? settleInPlot(before, b, plot) : b)) : boxes;
    // A zone that grew taller than the top storey opens a storey above.
    const storeys = storeysFor(settled, get().storeys);
    const moved = settled.find((b) => b.id === id);
    let arrows = get().arrows;
    if (moved) {
      // An arrow follows its host between floors...
      arrows = arrows.map((a) => (a.hostId === id ? { ...a, level: Math.min(Math.max(a.level, moved.level), moved.levelTo) } : a));
      // ...and loses its place if the zone became a void on that floor.
      arrows = arrows.filter((a) => a.hostId !== id || !isOpenToBelow(moved, a.level));
    }
    set({ boxes: settled, storeys, arrows });
  },

  deleteBoxes(ids) {
    get().remember();
    const idSet = new Set(ids);
    get().commitBoxes(get().boxes.map((b) => (idSet.has(b.id) ? { ...b, deleted: true } : b)));
    set({
      selected: get().selected.filter((s) => !idSet.has(s)),
      // A zone's arrows go with it.
      arrows: get().arrows.filter((a) => !idSet.has(a.hostId)),
    });
  },

  touchSelected() {
    const { boxes, selected, level } = get();
    if (!selected.length) return;
    get().remember();
    const settled = touchSelected(liveBoxes(boxes, level), selected);
    const byId = new Map(settled.map((b) => [b.id, b]));
    const merged = boxes.map((b) => byId.get(b.id) ?? b);
    // Closing a gap can push a zone through the boundary; the group comes
    // back in as one, so the gaps it just closed stay closed.
    set({ boxes: clampGroup(merged, selected, get().plot) });
  },

  addArrow(hostId, at) {
    const host = get().boxes.find((b) => b.id === hostId);
    // No door into a void: on a storey above its own floor a zone is
    // open to below, and there is no floor there to walk on.
    if (!host || isOpenToBelow(host, get().level)) return;
    get().remember();
    const { side, t } = nearestWallPoint(host, at);
    const arrow: Arrow = { id: newArrowId(), level: get().level, hostId, side, t, dir: 1 };
    set({ arrows: [...get().arrows, arrow], selectedArrow: arrow.id, selected: [] });
  },

  moveArrow(id, at) {
    const arrow = get().arrows.find((a) => a.id === id);
    const host = arrow && get().boxes.find((b) => b.id === arrow.hostId);
    if (!arrow || !host) return;
    const { side, t } = nearestWallPoint(host, at);
    // Moved by hand: it no longer stands for the suggestion it came from.
    set({ arrows: get().arrows.map((a) => (a.id === id ? { ...a, side, t, targetId: undefined } : a)) });
  },

  flipArrow(id) {
    get().remember();
    set({ arrows: get().arrows.map((a) => (a.id === id ? { ...a, dir: a.dir === 1 ? -1 : 1 } : a)) });
  },

  deleteArrow(id) {
    get().remember();
    set({ arrows: get().arrows.filter((a) => a.id !== id), selectedArrow: get().selectedArrow === id ? null : get().selectedArrow });
  },

  selectArrow(id) {
    set({ selectedArrow: id, selected: id ? [] : get().selected });
  },

  suggestArrows() {
    get().remember();
    const { boxes, arrows, level } = get();
    const mine = arrows.filter((a) => a.level === level);
    set({ arrows: [...arrows, ...suggestArrows(liveBoxes(boxes, level), mine, level)] });
  },

  carve(id) {
    const boxes = get().boxes;
    const carver = boxes.find((b) => b.id === id);
    if (!carver) return;
    get().remember();
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
    get().remember();
    set({ boxes: releaseCarve(id, get().boxes) });
  },

  resetLayout() {
    get().remember();
    const boxes = get().recommended;
    set({
      boxes,
      arrows: get().recommendedArrows,
      plot: get().recommendedPlot,
      storeys: storeysFor(boxes, SAMPLE_STOREYS),
      selected: [],
      selectedArrow: null,
    });
  },

  remember() {
    const { boxes, arrows, storeys, plot, past } = get();
    set({ past: [...past.slice(-(HISTORY_MAX - 1)), { boxes, arrows, storeys, plot }], future: [] });
  },

  undo() {
    const { past, future, boxes, arrows, storeys, plot, level } = get();
    if (!past.length) return;
    const prev = past[past.length - 1];
    set({
      ...prev,
      past: past.slice(0, -1),
      future: [...future, { boxes, arrows, storeys, plot }],
      level: Math.min(level, prev.storeys - 1),
      selected: [],
      selectedArrow: null,
    });
  },

  redo() {
    const { past, future, boxes, arrows, storeys, plot, level } = get();
    if (!future.length) return;
    const next = future[future.length - 1];
    set({
      ...next,
      future: future.slice(0, -1),
      past: [...past, { boxes, arrows, storeys, plot }],
      level: Math.min(level, next.storeys - 1),
      selected: [],
      selectedArrow: null,
    });
  },

  setPlot(patch) {
    get().remember();
    const plot = { ...get().plot, ...patch };
    // Nothing is dragged in. A zone already over the line stays where it
    // is and is flagged: the tool moves what you are holding and nothing
    // else, and switching a boundary on is not a licence to rearrange a
    // drawing the person has not asked about.
    set({ plot });
  },

  togglePlot() {
    get().setPlot({ on: !get().plot.on });
  },

  addStorey() {
    get().remember();
    set({ storeys: get().storeys + 1, level: get().storeys });
  },

  removeStorey() {
    const { storeys, boxes } = get();
    const top = storeys - 1;
    // Only an empty top storey goes: a zone reaching it would have
    // nowhere to be, and quietly deleting rooms is not this tool's job.
    if (storeys <= 1 || liveBoxes(boxes, top).length) return;
    get().remember();
    set({ storeys: top, level: Math.min(get().level, top - 1), selected: [], selectedArrow: null });
  },

  setLevel(level) {
    set({ level, selected: [], selectedArrow: null });
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
  toggleAbove() {
    set({ showAbove: !get().showAbove });
  },
  toggleMoveIn3D() {
    set({ moveIn3D: !get().moveIn3D });
  },
  toggleAutoCarve() {
    set({ autoCarve: !get().autoCarve });
  },

  async refreshProjects() {
    try {
      set({ projects: await api.listProjects() });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  async saveProject(name) {
    const { boxes, arrows, storeys, plot, savedId } = get();
    const body = { name, boxes, arrows, storeys, plot };
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
      get().remember();
      const boxes = saved.boxes.map(normalise);
      const arrows = saved.arrows ?? [];
      const storeys = storeysFor(boxes, saved.storeys);
      // Layouts saved before the plot existed have none; they open on the
      // sheet's rectangle, switched off, exactly as they behaved then.
      const plot = saved.plot ?? DEFAULT_PLOT;
      set({
        boxes,
        arrows,
        recommended: boxes,
        recommendedArrows: arrows,
        plot,
        recommendedPlot: plot,
        storeys,
        level: Math.min(get().level, Math.max(0, storeys - 1)),
        selected: [],
        selectedArrow: null,
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

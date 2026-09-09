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
import type { ProjectSummary, SavedProject } from "../api/types";
import { liveWallPoint, newArrowId, suggestArrows } from "../geometry/arrows";
import { carveWith, displayShapes, releaseCarve } from "../geometry/carve";
import { syncFrozenArrowPoints } from "../geometry/circulation";
import { clampDrawnRect, clampGroup, settleInPlot } from "../geometry/plot";
import { localPolyOf, polyArea } from "../geometry/poly";
import { isOpenToBelow, liveBoxes } from "../geometry/snap";
import { touchSelected } from "../geometry/touch";
import type { Actor, ActorRole, Arrow, Box, BoxShape, Plot, Point } from "../geometry/types";
import { roomTypeInfo } from "../rooms";
import { DEFAULT_PLOT, DEFAULT_PRIORITY, SAMPLE_STOREYS, STOREY_HEIGHT_M, sampleArrows, sampleBoxes, storeysSpanned } from "../sample";

/** A fixed rotation, not a colour per role: two actors of the same role
 * (two guests, say) still need to read as two different lines on the
 * plan, so colour follows creation order rather than being guessed from
 * what the actor is. */
const ACTOR_COLORS = ["#3B4B96", "#1E8F7A", "#C1583B", "#B08A2E", "#6B4E8E", "#3E7C8C", "#8C5A6B", "#5A7A3E"];

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
 * `pan` moves the view, `rect` and `circle` draw a new zone with one
 * drag, `polygon` draws one click at a time -- hold Shift on a click to
 * keep that wall square to the last one, or don't for a free angle --
 * closed by clicking its own first point or pressing Enter. `arrow` puts
 * an interior door arrow on the wall you click, `arrow-main` and
 * `arrow-side` do the same for the building's exterior doors. `place`
 * is not a drawing tool: it drops the zone named by `placingId` where
 * you next click, and is entered from the schedule, never the rail. */
export type Tool = "select" | "pan" | "rect" | "circle" | "polygon" | "arrow" | "arrow-main" | "arrow-side" | "place";

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
  /** The zone `place` is waiting to drop, if any (state.tool === "place"). */
  placingId: string | null;
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
  /** Who walks the plan, and where. Not in the undo history: an actor is
   * an analysis laid over the drawing, not a change to it, the same way
   * the selection and the camera are not either. Deleting one is instant. */
  actors: Actor[];
  /** Draw every visible actor's route on the plan. Off by default, like
   * every other overlay on the rail. */
  showCirculation: boolean;
  /** The actor a click on a zone adds a waypoint to, while it is set. */
  routingActorId: string | null;
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
  /** A new polygon zone, from the points the polygon tool collected
   * (plan-frame meters, at least 3, in order). Its bounding box becomes
   * `left`/`top`/`width`/`height` and the points are kept as fractions of
   * it, so it resizes exactly like a rectangle. Returns its id. */
  addPolygonBox: (points: Point[]) => string;
  /** A zone entered in the schedule, with a size but no position: sized
   * and typed, unplaced, on the current storey until `placeBox` gives it
   * one. Returns its id. */
  addUnplacedBox: (roomType: string, name: string, width: number, height: number, shape: BoxShape) => string;
  /** Arm `place`: the next click on the sheet gives this zone a position
   * and it joins the plan. */
  beginPlacement: (id: string) => void;
  /** Where `place` dropped it: the zone's new position, clamped to the
   * plot exactly like a freshly drawn one, and placed. */
  placeBox: (id: string, left: number, top: number) => void;
  /** A schedule edit: name, type, floor, rotation, size. */
  updateBox: (id: string, patch: Partial<Box>) => void;
  deleteBoxes: (ids: string[]) => void;
  /** Taken off the plan, not out of existence: it drops any carve
   * relationships (both what carved it and what it carved) and reappears
   * in the schedule's "To place" list, exactly like a zone typed there by
   * hand, ready to be dropped onto the plot again. Its door arrows are
   * left alone -- they come back with it if it is re-placed. */
  unplaceBoxes: (ids: string[]) => void;
  /** The box cuts every room it sits over, on its own storey. */
  carve: (id: string) => void;
  /** The box stops cutting anything. */
  release: (id: string) => void;
  /** Freezes the zone's outline as it stands right now -- cut by whatever
   * currently carves it, or plain if nothing does -- into a polygon of
   * its own that can be reshaped corner by corner. The carve that made
   * this cut is released, since it is now baked into the shape and
   * reapplying it live would cut the same bite twice; carving `id` does
   * elsewhere is untouched. */
  convertToPolygon: (id: string) => void;
  /** Reverts a polygon zone to a plain rectangle, sized to the same
   * area the polygon actually enclosed (never its bounding box, which
   * is only ever equal or larger) -- centred where the polygon was, at
   * the bounding box's own aspect ratio. Not the inverse of
   * `convertToPolygon`: this discards the exact outline for a round
   * number, on purpose. */
  convertToRect: (id: string) => void;
  /** Move every selected zone to touch its nearest neighbour (touch.ts). */
  touchSelected: () => void;
  /** A door arrow on `hostId`'s wall nearest the page point. `kind`
   * defaults to an interior door; `exterior-main` also makes the host
   * `isEntry` and clears it from whichever zone had it before. */
  addArrow: (hostId: string, at: Point, kind?: Arrow["kind"]) => void;
  moveArrow: (id: string, at: Point) => void;
  flipArrow: (id: string) => void;
  deleteArrow: (id: string) => void;
  selectArrow: (id: string | null) => void;
  /** Propose arrows for zones that have none yet (arrows.ts). */
  suggestArrows: () => void;
  /** A new actor, named and coloured, with an empty route. Returns its id. */
  addActor: (name: string, role: ActorRole) => string;
  updateActor: (id: string, patch: Partial<Pick<Actor, "name" | "role">>) => void;
  deleteActor: (id: string) => void;
  toggleActorVisible: (id: string) => void;
  /** `hostId` joins the end of the actor's route. */
  addWaypoint: (actorId: string, hostId: string) => void;
  removeWaypoint: (actorId: string, index: number) => void;
  clearWaypoints: (actorId: string) => void;
  /** Arm or disarm route recording: while set, clicking a zone on the
   *  plan calls `addWaypoint` instead of selecting it. */
  setRoutingActor: (id: string | null) => void;
  toggleCirculation: () => void;
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
    placed: b.placed ?? true,
    heightM,
    levelTo: b.level + storeysSpanned(heightM) - 1,
  };
}

/** The storeys a set of boxes needs: at least what the layout says, and
 * enough for the tallest zone to be seen on every storey it reaches. */
function storeysFor(boxes: Box[], atLeast: number): number {
  return Math.max(atLeast, ...boxes.filter((b) => !b.deleted).map((b) => b.levelTo + 1));
}

/** The saved-layout schema's own version. Bump it, and add a branch
 * below keyed on `saved.version`, the day a saved field needs real
 * translation rather than just "default it if missing" -- every change
 * to the shape so far (the plot, actors) has been the latter, which is
 * why `migrateLayout` reads the same for every version to date. */
export const LAYOUT_SCHEMA_VERSION = 1;

/** A saved layout, however old, turned into what the store actually
 * needs: every box normalised and every field that has not always
 * existed defaulted once, here, instead of as a scattered `?? default`
 * at whichever call site happens to read a saved project. */
export function migrateLayout(saved: SavedProject): { boxes: Box[]; arrows: Arrow[]; storeys: number; plot: Plot; actors: Actor[] } {
  const boxes = saved.boxes.map(normalise);
  const arrows = saved.arrows ?? [];
  // Layouts saved before the plot existed have none; they open on the
  // sheet's rectangle, switched off, exactly as they behaved then.
  const plot = saved.plot ?? DEFAULT_PLOT;
  // Layouts saved before circulation existed have none.
  const actors = saved.actors ?? [];
  const storeys = storeysFor(boxes, saved.storeys);
  return { boxes, arrows, storeys, plot, actors };
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
  placingId: null,
  busy: null,
  error: null,
  showGrid: false,
  massing: "zones",
  showGhost: true,
  showAbove: false,
  moveIn3D: false,
  autoCarve: false,
  actors: [],
  showCirculation: false,
  routingActorId: null,
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
    // The sample's own front door, plus its suggested arrows: one
    // interior door per room, walked out from that front door.
    let arrows: Arrow[] = sampleArrows(boxes);
    for (let lv = 0; lv < SAMPLE_STOREYS; lv++) arrows = [...arrows, ...suggestArrows(liveBoxes(boxes, lv), arrows, lv, get().autoCarve)];
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
      tool: "select",
      placingId: null,
      savedId: null,
      savedName: "",
      actors: [],
      routingActorId: null,
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
      placed: true,
      initial: rect,
    };
    set({ boxes: [...get().boxes, box], selected: [id] });
    return id;
  },

  addPolygonBox(points) {
    get().remember();
    const level = get().level;
    const info = roomTypeInfo("other");
    const id = `zone:${Date.now().toString(36)}:${nextZone}`;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const width = Math.max(0.01, Math.max(...xs) - left);
    const height = Math.max(0.01, Math.max(...ys) - top);
    const rect = { left, top, width, height };
    const normalised: Point[] = points.map(([x, y]) => [(x - left) / width, (y - top) / height]);
    const box: Box = {
      id,
      name: `Zone ${nextZone++}`,
      kind: "room",
      shape: "polygon",
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
      placed: true,
      initial: rect,
      points: normalised,
    };
    set({ boxes: [...get().boxes, box], selected: [id] });
    return id;
  },

  addUnplacedBox(roomType, name, width, height, shape) {
    get().remember();
    const level = get().level;
    const info = roomTypeInfo(roomType);
    const num = nextZone++;
    const id = `zone:${Date.now().toString(36)}:${num}`;
    const w = Math.max(info.minWidth, width);
    const h = Math.max(info.minHeight, height);
    const rect = { left: 0, top: 0, width: w, height: h };
    const box: Box = {
      id,
      name: name.trim() || `Zone ${num}`,
      kind: roomType === "hallway" ? "corridor" : "room",
      shape,
      roomType,
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
      placed: false,
      initial: rect,
    };
    set({ boxes: [...get().boxes, box] });
    return id;
  },

  beginPlacement(id) {
    set({ tool: "place", placingId: id, selected: [], selectedArrow: null });
  },

  placeBox(id, left, top) {
    const box = get().boxes.find((b) => b.id === id);
    if (!box) return;
    get().remember();
    // Held inside the plot exactly like a rectangle just drawn -- the
    // schedule is not a way to drop a zone somewhere the canvas would
    // never have let it land.
    const rect = clampDrawnRect({ left, top, width: box.width, height: box.height }, get().plot);
    const boxes = get().boxes.map((b) => (b.id === id ? { ...b, ...rect, placed: true } : b));
    const storeys = storeysFor(boxes, get().storeys);
    set({ boxes, storeys, tool: "select", placingId: null, selected: [id] });
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
      // ...and so does its place in any actor's route.
      actors: get().actors.map((a) => ({ ...a, waypoints: a.waypoints.filter((id) => !idSet.has(id)) })),
    });
  },

  unplaceBoxes(ids) {
    get().remember();
    const idSet = new Set(ids);
    let boxes = get().boxes.map((b) => (idSet.has(b.id) ? { ...b, placed: false, carvedBy: [] } : b));
    // Nothing it was cutting should still look cut once it is off the plan.
    for (const id of ids) boxes = releaseCarve(id, boxes);
    set({ boxes, selected: get().selected.filter((s) => !idSet.has(s)) });
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

  addArrow(hostId, at, kind = "interior") {
    const { boxes, level, autoCarve } = get();
    const host = boxes.find((b) => b.id === hostId);
    // No door into a void: on a storey above its own floor a zone is
    // open to below, and there is no floor there to walk on.
    if (!host || isOpenToBelow(host, level)) return;
    // Resolved against the zone's current, carved outline -- never a
    // point a carve has already taken away -- and hosted on whichever
    // zone (this one, or a carver cutting into it) that point actually
    // belongs to.
    const live = liveBoxes(boxes, level);
    const polyById = new Map(displayShapes(live, autoCarve).map((s) => [s.id, s.page]));
    const resolved = liveWallPoint(host, live, polyById, at);
    if (!resolved) return;
    get().remember();
    const arrow: Arrow = { id: newArrowId(), level, hostId: resolved.host.id, side: resolved.side, t: resolved.t, dir: 1, kind };
    // The main entrance is one zone at a time: this one takes it, and
    // whichever zone had it loses it.
    const nextBoxes =
      kind === "exterior-main"
        ? boxes.map((b) => (b.id === resolved.host.id ? { ...b, isEntry: true } : b.isEntry ? { ...b, isEntry: false } : b))
        : boxes;
    set({ arrows: [...get().arrows, arrow], selectedArrow: arrow.id, selected: [], boxes: nextBoxes });
  },

  moveArrow(id, at) {
    const { boxes, level, autoCarve, arrows } = get();
    const arrow = arrows.find((a) => a.id === id);
    const host = arrow && boxes.find((b) => b.id === arrow.hostId);
    if (!arrow || !host) return;
    const live = liveBoxes(boxes, level);
    const polyById = new Map(displayShapes(live, autoCarve).map((s) => [s.id, s.page]));
    const resolved = liveWallPoint(host, live, polyById, at);
    if (!resolved) return;
    // Moved by hand: it no longer stands for the suggestion it came from.
    set({
      arrows: arrows.map((a) =>
        a.id === id ? { ...a, hostId: resolved.host.id, side: resolved.side, t: resolved.t, targetId: undefined } : a,
      ),
    });
  },

  flipArrow(id) {
    get().remember();
    set({ arrows: get().arrows.map((a) => (a.id === id ? { ...a, dir: a.dir === 1 ? -1 : 1 } : a)) });
  },

  deleteArrow(id) {
    const arrow = get().arrows.find((a) => a.id === id);
    get().remember();
    // Deleting the main entrance un-marks its host: no arrow, no front door.
    const boxes =
      arrow?.kind === "exterior-main" ? get().boxes.map((b) => (b.id === arrow.hostId ? { ...b, isEntry: false } : b)) : get().boxes;
    set({
      arrows: get().arrows.filter((a) => a.id !== id),
      selectedArrow: get().selectedArrow === id ? null : get().selectedArrow,
      boxes,
    });
  },

  selectArrow(id) {
    set({ selectedArrow: id, selected: id ? [] : get().selected });
  },

  suggestArrows() {
    get().remember();
    const { boxes, arrows, level, autoCarve } = get();
    const mine = arrows.filter((a) => a.level === level);
    set({ arrows: [...arrows, ...suggestArrows(liveBoxes(boxes, level), mine, level, autoCarve)] });
  },

  addActor(name, role) {
    const actors = get().actors;
    const id = `actor:${Date.now().toString(36)}:${actors.length}`;
    const color = ACTOR_COLORS[actors.length % ACTOR_COLORS.length];
    const actor: Actor = { id, name: name.trim() || "Actor", role, color, waypoints: [], visible: true };
    set({ actors: [...actors, actor] });
    return id;
  },

  updateActor(id, patch) {
    set({ actors: get().actors.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  },

  deleteActor(id) {
    set({
      actors: get().actors.filter((a) => a.id !== id),
      routingActorId: get().routingActorId === id ? null : get().routingActorId,
    });
  },

  toggleActorVisible(id) {
    set({ actors: get().actors.map((a) => (a.id === id ? { ...a, visible: !a.visible } : a)) });
  },

  addWaypoint(actorId, hostId) {
    set({ actors: get().actors.map((a) => (a.id === actorId ? { ...a, waypoints: [...a.waypoints, hostId] } : a)) });
  },

  removeWaypoint(actorId, index) {
    set({
      actors: get().actors.map((a) => (a.id === actorId ? { ...a, waypoints: a.waypoints.filter((_, i) => i !== index) } : a)),
    });
  },

  clearWaypoints(actorId) {
    set({ actors: get().actors.map((a) => (a.id === actorId ? { ...a, waypoints: [] } : a)) });
  },

  setRoutingActor(id) {
    set({ routingActorId: id, showCirculation: id ? true : get().showCirculation });
  },

  toggleCirculation() {
    set({ showCirculation: !get().showCirculation });
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

  convertToPolygon(id) {
    const boxes = get().boxes;
    const box = boxes.find((b) => b.id === id);
    if (!box) return;
    const shape = displayShapes(liveBoxes(boxes, box.level), get().autoCarve).find((s) => s.id === id);
    const local = shape?.local ?? localPolyOf(box);
    if (local.length < 3) return;
    get().remember();
    const xs = local.map((p) => p[0]);
    const ys = local.map((p) => p[1]);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const width = Math.max(0.01, Math.max(...xs) - left);
    const height = Math.max(0.01, Math.max(...ys) - top);
    const points: Point[] = local.map(([x, y]) => [(x - left) / width, (y - top) / height]);
    set({
      boxes: boxes.map((b) => (b.id === id ? { ...b, shape: "polygon", points, left, top, width, height, carvedBy: [] } : b)),
    });
  },

  convertToRect(id) {
    const boxes = get().boxes;
    const box = boxes.find((b) => b.id === id);
    if (!box || box.shape !== "polygon" || !box.points || box.points.length < 3) return;
    get().remember();
    // box.points are fractions of the bounding box, so polyArea on them
    // is the polygon's own area as a fraction of box.width * box.height
    // -- scaling both dimensions by its square root keeps the bounding
    // box's aspect ratio while making the new rectangle's actual area
    // match what the polygon enclosed.
    const scale = Math.sqrt(polyArea(box.points));
    const width = Math.max(0.01, box.width * scale);
    const height = Math.max(0.01, box.height * scale);
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    set({
      boxes: boxes.map((b) =>
        b.id === id ? { ...b, shape: "rect", points: undefined, left: cx - width / 2, top: cy - height / 2, width, height } : b,
      ),
    });
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
    // Leaving "place" for anything else drops what it was armed with;
    // entering it is only ever through beginPlacement, which sets both
    // at once.
    set({ tool, placingId: tool === "place" ? get().placingId : null });
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
    const { boxes, arrows, storeys, plot, actors, savedId } = get();
    const body = { name, boxes, arrows, storeys, plot, actors, version: LAYOUT_SCHEMA_VERSION };
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
      const { boxes, arrows, storeys, plot, actors } = migrateLayout(saved);
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
        tool: "select",
        placingId: null,
        savedId: saved.id,
        savedName: saved.name,
        actors,
        routingActorId: null,
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

// Every arrow's frozen position (Arrow.frozenAt, circulation.ts) kept in
// sync after every single edit, in one place, rather than each of the
// many actions that could move a wall -- draw, resize, rotate, carve,
// release a carve, undo, redo, load a layout -- having to remember to
// call it themselves. `syncFrozenArrowPoints` is a no-op (same array
// back) once nothing has changed, so this settles in one extra pass
// rather than looping.
useStore.subscribe((state) => {
  const arrows = syncFrozenArrowPoints(state.boxes, state.arrows, state.autoCarve);
  if (arrows !== state.arrows) useStore.setState({ arrows });
});

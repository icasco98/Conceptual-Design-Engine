/**
 * The single source of truth for what is on the canvas.
 *
 * The 2D canvas, the 3D view, the schedule and the checks all read from
 * here and nothing else. Python supplies a recommendation (boxes per
 * level) and answers questions about an arrangement; the arrangement
 * itself lives here, in plan-frame meters, and every edit goes through
 * these actions.
 */
import { create } from "zustand";

import { api } from "../api/client";
import { arrangementToBoxes, boxesToArrangement, buildingToBoxes, envelopeToPlan } from "../api/convert";
import type {
  AccessProblem,
  ChatMessage,
  Issue,
  LayoutOut,
  LayoutPlan,
  Project,
  ProjectSummary,
} from "../api/types";
import { applyRotations, rotationReport } from "../geometry/rotate";
import type { Box, Envelope } from "../geometry/types";

/** What the 3D pane draws: coloured zones per room, or one grey volume. */
export type MassingMode = "zones" | "mass";

export interface State {
  project: Project | null;
  layoutPlan: LayoutPlan | null;
  envelope: Envelope | null;
  boxes: Box[];
  recommended: Box[];
  level: number;
  selected: string[];
  history: ChatMessage[];
  issues: Issue[];
  accessProblems: AccessProblem[];
  stackingIssues: Issue[];
  notes: string;
  hasApiKey: boolean;
  busy: string | null;
  error: string | null;
  showGrid: boolean;
  massing: MassingMode;
  showGhost: boolean;
  savedId: string | null;
  savedName: string;
  projects: ProjectSummary[];

  boot: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  applyLayout: (out: LayoutOut, project: Project) => void;
  setBoxes: (boxes: Box[]) => void;
  commitBoxes: (boxes: Box[]) => void;
  select: (id: string | null, additive?: boolean) => void;
  deleteBoxes: (ids: string[]) => void;
  resetLayout: () => void;
  setLevel: (level: number) => void;
  setMassing: (massing: MassingMode) => void;
  toggleGrid: () => void;
  toggleGhost: () => void;
  runCheck: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  saveProject: (name: string) => Promise<void>;
  loadProject: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  newProject: () => Promise<void>;
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

let checkTimer: ReturnType<typeof setTimeout> | null = null;

export const useStore = create<State>((set, get) => ({
  project: null,
  layoutPlan: null,
  envelope: null,
  boxes: [],
  recommended: [],
  level: 0,
  selected: [],
  history: [],
  issues: [],
  accessProblems: [],
  stackingIssues: [],
  notes: "",
  hasApiKey: false,
  busy: null,
  error: null,
  showGrid: false,
  massing: "zones",
  showGhost: true,
  savedId: null,
  savedName: "",
  projects: [],

  async boot() {
    try {
      const health = await api.health();
      set({ hasApiKey: health.has_api_key });
      await get().newProject();
      await get().refreshProjects();
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  async newProject() {
    set({ busy: "Loading the sample project…" });
    try {
      const sample = await api.sample();
      const out = await api.layout(sample.project, sample.layout_plan);
      set({ layoutPlan: sample.layout_plan, history: [], savedId: null, savedName: "" });
      get().applyLayout(out, sample.project);
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: null });
    }
  },

  applyLayout(out, project) {
    const boxes = out.building ? buildingToBoxes(out.building.levels, project) : [];
    set({
      project,
      envelope: out.envelope ? envelopeToPlan(out.envelope, project) : null,
      boxes,
      recommended: boxes,
      issues: out.issues,
      accessProblems: out.access_problems,
      stackingIssues: out.stacking_issues,
      notes: out.notes,
      selected: [],
      level: Math.min(get().level, Math.max(0, project.storeys - 1)),
    });
  },

  async sendMessage(text) {
    const history: ChatMessage[] = [...get().history, { role: "user", content: text }];
    set({ history, busy: "Reading that…" });
    try {
      const project = get().project;
      const arrangement = project ? boxesToArrangement(get().boxes, project) : null;
      const out = await api.chat(history, arrangement);
      const next: ChatMessage[] = [...history, { role: "assistant", content: out.assistant_message }];
      if (out.explanation) next.push({ role: "assistant", content: out.explanation });
      set({ history: next, layoutPlan: out.layout_plan, busy: "Arranging the rooms…" });
      const layout = await api.layout(out.project, out.layout_plan);
      get().applyLayout(layout, out.project);
      // Rotations asked for in words go through the same rules a hand
      // rotation goes through, on the arrangement that was just packed.
      // Whatever will not fit is said out loud rather than dropped.
      if (out.rotations.length) {
        const envelope = get().envelope;
        if (envelope) {
          const outcome = applyRotations(get().boxes, out.rotations, envelope, out.project.storeys);
          get().commitBoxes(outcome.boxes);
          const report = rotationReport(outcome);
          if (report) set({ history: [...get().history, { role: "assistant", content: report }] });
        }
      }
    } catch (e) {
      set({ history: [...history, { role: "assistant", content: `Couldn't reach Claude: ${(e as Error).message}` }] });
    } finally {
      set({ busy: null });
    }
  },

  /** Mid-gesture: every frame. No stair sync, no check. */
  setBoxes(boxes) {
    set({ boxes });
  },

  /** Gesture over: stairs mirrored across levels, checks re-run. */
  commitBoxes(boxes) {
    const before = new Map(get().boxes.map((b) => [b.id, b]));
    const changed = new Set(boxes.filter((b) => before.get(b.id) !== b).map((b) => b.id));
    set({ boxes: syncStairs(boxes, changed) });
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = setTimeout(() => void get().runCheck(), 250);
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
    void get().runCheck();
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

  async runCheck() {
    const project = get().project;
    if (!project) return;
    try {
      const out = await api.check(project, boxesToArrangement(get().boxes, project));
      set({ accessProblems: out.access_problems, stackingIssues: out.stacking_issues });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  async refreshProjects() {
    try {
      set({ projects: await api.listProjects() });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  async saveProject(name) {
    const { project, layoutPlan, boxes, history, savedId } = get();
    if (!project) return;
    const body = { name, project, layout_plan: layoutPlan, arrangement: boxesToArrangement(boxes, project), history };
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
      const out = await api.layout(saved.project, saved.layout_plan);
      set({ layoutPlan: saved.layout_plan, history: saved.history, savedId: saved.id, savedName: saved.name });
      get().applyLayout(out, saved.project);
      if (saved.arrangement) {
        const boxes = arrangementToBoxes(saved.arrangement, saved.project, get().recommended);
        set({ boxes });
        await get().runCheck();
      }
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

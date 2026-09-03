import type {
  ArrangementIn,
  ChatMessage,
  ChatOut,
  CheckOut,
  LayoutOut,
  LayoutPlan,
  Project,
  ProjectSummary,
  SavedProject,
} from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* keep statusText */
    }
    throw new Error(detail);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  health: () => request<{ ok: boolean; has_api_key: boolean }>("/api/health"),
  sample: () => request<{ project: Project; layout_plan: LayoutPlan }>("/api/sample"),
  layout: (project: Project, layout_plan: LayoutPlan | null) =>
    post<LayoutOut>("/api/layout", { project, layout_plan }),
  check: (project: Project, arrangement: ArrangementIn) => post<CheckOut>("/api/check", { project, arrangement }),
  chat: (history: ChatMessage[], arrangement: ArrangementIn | null) =>
    post<ChatOut>("/api/chat", { history, arrangement }),
  listProjects: () => request<ProjectSummary[]>("/api/projects"),
  getProject: (id: string) => request<SavedProject>(`/api/projects/${id}`),
  createProject: (body: Omit<SavedProject, keyof ProjectSummary> & { name: string }) =>
    post<SavedProject>("/api/projects", body),
  updateProject: (id: string, body: Omit<SavedProject, keyof ProjectSummary> & { name: string }) =>
    request<SavedProject>(`/api/projects/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: "DELETE" }),
};

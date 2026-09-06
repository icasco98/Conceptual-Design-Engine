import type { LayoutBody, ProjectSummary, SavedProject } from "./types";

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
  health: () => request<{ ok: boolean }>("/api/health"),
  listProjects: () => request<ProjectSummary[]>("/api/projects"),
  getProject: (id: string) => request<SavedProject>(`/api/projects/${id}`),
  createProject: (body: LayoutBody & { name: string }) => post<SavedProject>("/api/projects", body),
  updateProject: (id: string, body: LayoutBody & { name: string }) =>
    request<SavedProject>(`/api/projects/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: "DELETE" }),
};

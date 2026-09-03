import { useState } from "react";

import { useStore } from "../state/store";

export function Sidebar() {
  const project = useStore((s) => s.project);
  const envelope = useStore((s) => s.envelope);
  const issues = useStore((s) => s.issues);
  const accessProblems = useStore((s) => s.accessProblems);
  const stackingIssues = useStore((s) => s.stackingIssues);
  const projects = useStore((s) => s.projects);
  const savedName = useStore((s) => s.savedName);
  const savedId = useStore((s) => s.savedId);
  const saveProject = useStore((s) => s.saveProject);
  const loadProject = useStore((s) => s.loadProject);
  const deleteProject = useStore((s) => s.deleteProject);
  const newProject = useStore((s) => s.newProject);
  const [name, setName] = useState("");

  if (!project) return null;
  const site = project.site;
  const totalRooms = project.rooms.reduce((n, r) => n + r.count, 0);

  return (
    <div className="sidebar">
      <section>
        <h3>Site</h3>
        {site.width_m && site.depth_m ? (
          <p>
            {site.width_m.toFixed(1)} m × {site.depth_m.toFixed(1)} m · {project.storeys}{" "}
            {project.storeys === 1 ? "storey" : "storeys"}
          </p>
        ) : (
          <p className="muted">not yet described</p>
        )}
        {site.edges.length > 0 && (
          <p className="muted">
            {site.edges.map((e) => `${e.position}: ${e.adjacency}`).join(" · ")}
          </p>
        )}
        <p className="muted">
          Setbacks {project.setbacks.street_m} m street · {project.setbacks.neighbor_m} m neighbour
          {envelope
            ? ` · buildable ${(envelope.right - envelope.left).toFixed(1)} × ${(envelope.bottom - envelope.top).toFixed(1)} m`
            : ""}
        </p>
      </section>

      <section>
        <h3>Program ({totalRooms} spaces)</h3>
        <ul className="rooms">
          {project.rooms.map((r) => (
            <li key={r.name}>
              {r.name}
              {r.count > 1 ? ` ×${r.count}` : ""}
              {project.storeys > 1 ? <span className="muted"> · L{r.levels.join(",")}</span> : null}
              {r.is_entry ? <span className="tag">entry</span> : null}
            </li>
          ))}
        </ul>
        {project.priorities.length > 0 && (
          <>
            <h4>Priorities</h4>
            <ul className="rooms">
              {project.priorities.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      {(issues.length > 0 || accessProblems.length > 0 || stackingIssues.length > 0) && (
        <section>
          <h3>Checks</h3>
          <ul className="issues">
            {issues.map((i) => (
              <li key={i.code + i.message} className={i.severity}>
                {i.message}
              </li>
            ))}
            {accessProblems.map((p) => (
              <li key={p.room_name} className="warning">
                {p.message}
              </li>
            ))}
            {stackingIssues.map((i) => (
              <li key={i.code + i.message} className="warning">
                {i.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3>Projects</h3>
        <form
          className="save-row"
          onSubmit={(e) => {
            e.preventDefault();
            const n = (name || savedName || "Untitled").trim();
            void saveProject(n);
            setName("");
          }}
        >
          <input
            type="text"
            placeholder={savedName || "Project name"}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit">{savedId ? "Save" : "Save as new"}</button>
        </form>
        <ul className="projects">
          {projects.map((p) => (
            <li key={p.id} className={p.id === savedId ? "current" : ""}>
              <button type="button" className="link" onClick={() => void loadProject(p.id)}>
                {p.name}
              </button>
              <span className="muted">{new Date(p.updated_at).toLocaleDateString()}</span>
              <button type="button" className="icon" title="Delete" onClick={() => void deleteProject(p.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="secondary" onClick={() => void newProject()}>
          Start over with the sample
        </button>
      </section>
    </div>
  );
}

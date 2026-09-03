/**
 * Under the conversation: what Python worked out about the site, why the
 * packer arranged the rooms the way it did, and the saved projects. The
 * checks used to live here and now run along the foot of the window, where
 * they cannot be scrolled out of sight.
 */
import { useState } from "react";

import { useStore } from "../state/store";

export function Sidebar() {
  const project = useStore((s) => s.project);
  const envelope = useStore((s) => s.envelope);
  const notes = useStore((s) => s.notes);
  const layoutPlan = useStore((s) => s.layoutPlan);
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
  const rationale = [layoutPlan?.grouping_label, notes, layoutPlan?.rationale].filter(Boolean).join(" ");

  return (
    <div className="sidebar" style={{ display: "flex", flexDirection: "column", gap: 14, maxHeight: "42%", overflow: "auto", flex: "none" }}>
      <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="label">Site</div>
        <div className="facts">
          {site.width_m && site.depth_m ? (
            <div className="fact">
              <span>Lot</span>
              <b className="num">
                {site.width_m.toFixed(1)} × {site.depth_m.toFixed(1)} m
              </b>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
              Not yet described
            </p>
          )}
          {envelope && (
            <div className="fact">
              <span>Buildable</span>
              <b className="num">
                {(envelope.right - envelope.left).toFixed(1)} × {(envelope.bottom - envelope.top).toFixed(1)} m
              </b>
            </div>
          )}
          <div className="fact">
            <span>Setbacks</span>
            <b className="num">
              {project.setbacks.street_m} / {project.setbacks.neighbor_m} m
            </b>
          </div>
        </div>
        {project.priorities.length > 0 && (
          <ul className="rooms">
            {project.priorities.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </section>

      {rationale && (
        <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div className="label">Why this layout</div>
          <p className="muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>
            {rationale}
          </p>
        </section>
      )}

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="label">Projects</div>
        <form
          className="save-row"
          onSubmit={(e) => {
            e.preventDefault();
            void saveProject((name || savedName || "Untitled").trim());
            setName("");
          }}
        >
          <input
            type="text"
            placeholder={savedName || "Project name"}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="ghost-btn">
            {savedId ? "Save" : "Save as new"}
          </button>
        </form>
        <ul className="projects">
          {projects.map((p) => (
            <li key={p.id} className={p.id === savedId ? "current" : ""}>
              <button type="button" className="link" onClick={() => void loadProject(p.id)}>
                {p.name}
              </button>
              <span className="muted num">{new Date(p.updated_at).toLocaleDateString()}</span>
              <button type="button" className="icon" title={`Delete ${p.name}`} onClick={() => void deleteProject(p.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="ghost-btn" onClick={() => void newProject()}>
          Start over with the sample
        </button>
      </section>
    </div>
  );
}

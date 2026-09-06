/**
 * Saved layouts, under the schedule. Saving keeps the boxes exactly as
 * they are on the canvas; loading brings them back and makes that the
 * layout Reset returns to.
 */
import { useState } from "react";

import { useStore } from "../state/store";

export function Sidebar() {
  const projects = useStore((s) => s.projects);
  const savedName = useStore((s) => s.savedName);
  const savedId = useStore((s) => s.savedId);
  const saveProject = useStore((s) => s.saveProject);
  const loadProject = useStore((s) => s.loadProject);
  const deleteProject = useStore((s) => s.deleteProject);
  const newProject = useStore((s) => s.newProject);
  const [name, setName] = useState("");

  return (
    <div className="sidebar">
      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="label">Saved layouts</div>
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
            placeholder={savedName || "Layout name"}
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
        <button type="button" className="ghost-btn" onClick={() => newProject()}>
          Start over with the sample
        </button>
      </section>
    </div>
  );
}

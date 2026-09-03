import { useEffect } from "react";

import { Canvas2D } from "./components/Canvas2D";
import { ChatPanel } from "./components/ChatPanel";
import { Schedule } from "./components/Schedule";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { View3D } from "./components/View3D";
import { useStore } from "./state/store";

export default function App() {
  const boot = useStore((s) => s.boot);
  const view = useStore((s) => s.view);
  const busy = useStore((s) => s.busy);
  const error = useStore((s) => s.error);
  const clearError = useStore((s) => s.clearError);
  const project = useStore((s) => s.project);

  useEffect(() => {
    void boot();
  }, [boot]);

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Conceptual Design Engine</h1>
          <p className="subtitle">Zoning diagrams from a conversation. Drag anything; the numbers stay honest.</p>
        </div>
        {busy && <div className="busy">{busy}</div>}
      </header>
      {error && (
        <div className="error-bar" role="alert">
          <span>{error}</span>
          <button type="button" onClick={clearError}>
            Dismiss
          </button>
        </div>
      )}
      <div className="app-body">
        <aside className="left">
          <ChatPanel />
          <Sidebar />
        </aside>
        <main className="main">
          <Toolbar />
          {project ? (
            <div className={`views view-${view}`}>
              {(view === "2d" || view === "both") && (
                <section className="view-2d">
                  <Schedule />
                  <Canvas2D />
                </section>
              )}
              {(view === "3d" || view === "both") && (
                <section className="view-3d">
                  <View3D />
                </section>
              )}
            </div>
          ) : (
            <p className="placeholder">Loading…</p>
          )}
        </main>
      </div>
    </div>
  );
}

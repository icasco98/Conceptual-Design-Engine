/**
 * Layout: a tool rail, then three columns — the plan, the massing, and
 * the room schedule with the saved layouts under it. All three are on
 * screen at all times: they are three readings of one arrangement, never
 * modes you switch between. The status line runs along the foot where it
 * cannot scroll away.
 */
import { useEffect } from "react";

import { Canvas2D } from "./components/Canvas2D";
import { IconCircle, IconCursor, IconGrid, IconHand, IconLayers, IconRect, IconReset } from "./components/icons";
import { Massing } from "./components/Massing";
import { Schedule } from "./components/Schedule";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { useStore, type Tool } from "./state/store";

/** The rail: the pointer tools (select, pan, draw a rectangle, draw a
 *  circle), then the toggles (grid, ghost of the storey below), then
 *  Reset. */
function Rail() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const showGrid = useStore((s) => s.showGrid);
  const toggleGrid = useStore((s) => s.toggleGrid);
  const showGhost = useStore((s) => s.showGhost);
  const toggleGhost = useStore((s) => s.toggleGhost);
  const resetLayout = useStore((s) => s.resetLayout);
  const storeys = useStore((s) => s.storeys);

  const toolButton = (t: Tool, title: string, icon: React.ReactNode) => (
    <button type="button" className={tool === t ? "on" : ""} aria-pressed={tool === t} title={title} aria-label={title} onClick={() => setTool(t)}>
      {icon}
    </button>
  );

  return (
    <div className="rail">
      {toolButton("select", "Select and move (drag the sheet to select several; Shift adds)", <IconCursor />)}
      {toolButton("pan", "Pan the plan (or drag with the middle button)", <IconHand />)}
      {toolButton("rect", "Draw a rectangle zone (Shift for a square)", <IconRect />)}
      {toolButton("circle", "Draw a circle zone", <IconCircle />)}
      <span className="rail-sep" />
      <button
        type="button"
        className={showGrid ? "on" : ""}
        aria-pressed={showGrid}
        title="0.25 m grid"
        aria-label="0.25 m grid"
        onClick={toggleGrid}
      >
        <IconGrid />
      </button>
      {storeys > 1 && (
        <button
          type="button"
          className={showGhost ? "on" : ""}
          aria-pressed={showGhost}
          title="Show the storey below"
          aria-label="Show the storey below"
          onClick={toggleGhost}
        >
          <IconLayers />
        </button>
      )}
      <span className="rail-sep" />
      <button type="button" title="Reset to the sample layout" aria-label="Reset to the sample layout" onClick={resetLayout}>
        <IconReset />
      </button>
    </div>
  );
}

function Levels() {
  const storeys = useStore((s) => s.storeys);
  const level = useStore((s) => s.level);
  const setLevel = useStore((s) => s.setLevel);
  if (storeys < 2) return null;
  return (
    <div className="seg" role="tablist" aria-label="Storey">
      {Array.from({ length: storeys }, (_, i) => (
        <button
          key={i}
          type="button"
          role="tab"
          aria-selected={level === i}
          className={level === i ? "on" : ""}
          onClick={() => setLevel(i)}
        >
          {i === 0 ? "Ground floor" : `Level ${i}`}
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const boot = useStore((s) => s.boot);
  const busy = useStore((s) => s.busy);
  const error = useStore((s) => s.error);
  const clearError = useStore((s) => s.clearError);
  const boxes = useStore((s) => s.boxes);
  const storeys = useStore((s) => s.storeys);
  const selected = useStore((s) => s.selected);
  const savedName = useStore((s) => s.savedName);

  useEffect(() => {
    void boot();
  }, [boot]);

  const spaces = boxes.filter((b) => !b.deleted).length;

  return (
    <div className="app">
      <header className="app-header">
        <h1>{savedName || "Sample House"}</h1>
        <Levels />
        <div className="header-sp" />
        {busy && <div className="busy">{busy}</div>}
        {selected.length > 1 && <div className="busy">{selected.length} selected</div>}
        <div className="header-meta">
          {spaces} {spaces === 1 ? "space" : "spaces"} · {storeys} {storeys === 1 ? "storey" : "storeys"}
        </div>
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
        <Rail />
        <Canvas2D />
        <Massing />
        <div className="schedule-col">
          <div className="schedule-pane">
            <div className="label">Room schedule</div>
            <Schedule />
          </div>
          <Sidebar />
        </div>
      </div>

      <StatusBar />
    </div>
  );
}

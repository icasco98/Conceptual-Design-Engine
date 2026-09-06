/**
 * Layout: a tool rail, the plan, then a column carrying the massing over the
 * room schedule and the saved layouts. Plan and massing are both on screen
 * permanently — the two readings of one arrangement, never a mode you switch
 * between — and the status line runs along the foot where it cannot scroll
 * away.
 */
import { useEffect } from "react";

import { Canvas2D } from "./components/Canvas2D";
import { IconCursor, IconGrid, IconHand, IconLayers, IconReset } from "./components/icons";
import { Massing } from "./components/Massing";
import { Schedule } from "./components/Schedule";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { useStore } from "./state/store";

/** The rail is the tool vocabulary the canvas already speaks; grid and the
 *  ghost of the storey below are toggles, the rest are the pointer modes the
 *  canvas has always had. */
function Rail() {
  const showGrid = useStore((s) => s.showGrid);
  const toggleGrid = useStore((s) => s.toggleGrid);
  const showGhost = useStore((s) => s.showGhost);
  const toggleGhost = useStore((s) => s.toggleGhost);
  const resetLayout = useStore((s) => s.resetLayout);
  const storeys = useStore((s) => s.storeys);

  return (
    <div className="rail">
      <button type="button" className="on" title="Select and move" aria-label="Select and move" aria-pressed>
        <IconCursor />
      </button>
      <button type="button" title="Pan the plan (or drag the background)" aria-label="Pan the plan">
        <IconHand />
      </button>
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
        <div className="right-col">
          <Massing />
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

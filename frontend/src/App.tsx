/**
 * Layout: a tool rail, then three columns — the plan, the massing, and
 * the room schedule with the saved layouts under it. All three are on
 * screen at all times: they are three readings of one arrangement, never
 * modes you switch between. The status line runs along the foot where it
 * cannot scroll away.
 */
import { useEffect } from "react";

import { Canvas2D } from "./components/Canvas2D";
import {
  IconArrow,
  IconCarveAuto,
  IconCircle,
  IconCursor,
  IconGrid,
  IconHand,
  IconLayers,
  IconLayersUp,
  IconMagnet,
  IconRect,
  IconRedo,
  IconReset,
  IconSuggest,
  IconUndo,
} from "./components/icons";
import { Massing } from "./components/Massing";
import { Schedule } from "./components/Schedule";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { liveBoxes } from "./geometry/snap";
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
  const showAbove = useStore((s) => s.showAbove);
  const toggleAbove = useStore((s) => s.toggleAbove);
  const autoCarve = useStore((s) => s.autoCarve);
  const toggleAutoCarve = useStore((s) => s.toggleAutoCarve);
  const resetLayout = useStore((s) => s.resetLayout);
  const storeys = useStore((s) => s.storeys);
  const selected = useStore((s) => s.selected);
  const touchSelected = useStore((s) => s.touchSelected);
  const suggestArrows = useStore((s) => s.suggestArrows);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);

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
      {toolButton("arrow", "Add a door arrow: click a zone's wall", <IconArrow />)}
      <span className="rail-sep" />
      <button
        type="button"
        disabled={!selected.length}
        title="Make the selected zones touch their nearest neighbour (gaps under 1 m)"
        aria-label="Make the selected zones touch"
        onClick={touchSelected}
      >
        <IconMagnet />
      </button>
      <button type="button" title="Suggest door arrows for zones that have none" aria-label="Suggest door arrows" onClick={suggestArrows}>
        <IconSuggest />
      </button>
      <button
        type="button"
        className={autoCarve ? "on" : ""}
        aria-pressed={autoCarve}
        title="Automatic carving: where zones overlap, the higher priority carves the lower (priorities are in the schedule)"
        aria-label="Automatic carving"
        onClick={toggleAutoCarve}
      >
        <IconCarveAuto />
      </button>
      <span className="rail-sep" />
      <button type="button" disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo" onClick={undo}>
        <IconUndo />
      </button>
      <button type="button" disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo" onClick={redo}>
        <IconRedo />
      </button>
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
        <>
          <button
            type="button"
            className={showGhost ? "on" : ""}
            aria-pressed={showGhost}
            title="Outline the storey below"
            aria-label="Outline the storey below"
            onClick={toggleGhost}
          >
            <IconLayers />
          </button>
          <button
            type="button"
            className={showAbove ? "on" : ""}
            aria-pressed={showAbove}
            title="Outline the storey above"
            aria-label="Outline the storey above"
            onClick={toggleAbove}
          >
            <IconLayersUp />
          </button>
        </>
      )}
      <span className="rail-sep" />
      <button type="button" title="Reset to the sample layout" aria-label="Reset to the sample layout" onClick={resetLayout}>
        <IconReset />
      </button>
    </div>
  );
}

/** The storey tabs, and adding or removing one. The top storey can only
 *  go when nothing is on it: quietly deleting rooms is not this tool's
 *  job, and a zone tall enough to reach it holds it open. */
function Levels() {
  const storeys = useStore((s) => s.storeys);
  const level = useStore((s) => s.level);
  const setLevel = useStore((s) => s.setLevel);
  const addStorey = useStore((s) => s.addStorey);
  const removeStorey = useStore((s) => s.removeStorey);
  const topIsEmpty = useStore((s) => !liveBoxes(s.boxes, s.storeys - 1).length);

  return (
    <div className="levels">
      {storeys > 1 && (
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
      )}
      <button type="button" className="ghost-btn tight" title="Add a storey on top" onClick={addStorey}>
        + Storey
      </button>
      <button
        type="button"
        className="ghost-btn tight"
        disabled={storeys < 2 || !topIsEmpty}
        title={storeys < 2 ? "There is only one storey" : topIsEmpty ? "Remove the top storey" : "The top storey is not empty"}
        onClick={removeStorey}
      >
        − Storey
      </button>
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

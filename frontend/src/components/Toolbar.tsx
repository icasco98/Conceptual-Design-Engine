import { useStore } from "../state/store";

export function Toolbar() {
  const project = useStore((s) => s.project);
  const level = useStore((s) => s.level);
  const setLevel = useStore((s) => s.setLevel);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const showGrid = useStore((s) => s.showGrid);
  const toggleGrid = useStore((s) => s.toggleGrid);
  const showGhost = useStore((s) => s.showGhost);
  const toggleGhost = useStore((s) => s.toggleGhost);
  const resetLayout = useStore((s) => s.resetLayout);
  const notes = useStore((s) => s.notes);
  const layoutPlan = useStore((s) => s.layoutPlan);

  if (!project) return null;
  const storeys = project.storeys;

  return (
    <div className="toolbar">
      <div className="toolbar-row">
        <div className="segmented" role="tablist" aria-label="Storey">
          {Array.from({ length: storeys }, (_, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={level === i}
              className={level === i ? "active" : ""}
              onClick={() => setLevel(i)}
            >
              {i === 0 ? "Ground floor" : `Level ${i}`}
            </button>
          ))}
        </div>
        <div className="segmented" role="tablist" aria-label="View">
          {(["2d", "both", "3d"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              className={view === v ? "active" : ""}
              onClick={() => setView(v)}
            >
              {v === "2d" ? "Plan" : v === "3d" ? "3D" : "Plan + 3D"}
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={showGrid} onChange={toggleGrid} /> 0.25 m grid
        </label>
        {storeys > 1 && (
          <label className="check">
            <input type="checkbox" checked={showGhost} onChange={toggleGhost} /> Show level below
          </label>
        )}
        <button type="button" className="secondary" onClick={resetLayout}>
          Reset to recommended
        </button>
      </div>
      <p className="notes">
        {layoutPlan?.grouping_label ? <strong>{layoutPlan.grouping_label}. </strong> : null}
        {notes}
        {layoutPlan?.rationale ? ` ${layoutPlan.rationale}` : ""}
      </p>
    </div>
  );
}

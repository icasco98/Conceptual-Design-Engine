/**
 * The plot: the site boundary, and the checkbox that makes it bind.
 *
 * Off, the boundary is a dashed rectangle you can draw against and
 * ignore — the sheet's old behaviour, and the default, because the tool
 * cannot know the site until someone types it in. On, it is a hard wall:
 * no zone can be dragged, turned or resized through it.
 *
 * Switching it on never moves anything. Zones already over the line are
 * outlined on the plan and named in the status bar, and stay exactly
 * where they are until they are picked up.
 */
import { useStore } from "../state/store";

/** A metre field. Kept as text while it is being typed so that clearing
 *  it to retype does not snap the field back to a number mid-keystroke. */
function MetreField({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="plot-field">
      <span className="muted">{label}</span>
      <input
        type="number"
        step={0.25}
        min={min}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.max(min, v));
        }}
      />
    </label>
  );
}

export function PlotPanel() {
  const plot = useStore((s) => s.plot);
  const setPlot = useStore((s) => s.setPlot);
  const togglePlot = useStore((s) => s.togglePlot);

  return (
    <section className="plot-panel">
      <div className="label">Plot</div>
      <label className="plot-check" title="While this is ticked, no zone can leave the plot">
        <input type="checkbox" checked={plot.on} onChange={togglePlot} />
        <span>Restrict zones to the plot</span>
      </label>
      <div className="plot-grid">
        <MetreField label="Width (m)" value={plot.width} min={1} onChange={(width) => setPlot({ width })} />
        <MetreField label="Depth (m)" value={plot.depth} min={1} onChange={(depth) => setPlot({ depth })} />
        <MetreField label="X offset (m)" value={plot.left} min={0} onChange={(left) => setPlot({ left })} />
        <MetreField label="Y offset (m)" value={plot.top} min={0} onChange={(top) => setPlot({ top })} />
      </div>
      <div className="muted plot-note">
        {plot.on
          ? `${(plot.width * plot.depth).toFixed(0)} m² of plot. Zones stop at the edge as you drag them.`
          : `${(plot.width * plot.depth).toFixed(0)} m² of plot, for reference only. Tick the box to make it a wall.`}
      </div>
    </section>
  );
}

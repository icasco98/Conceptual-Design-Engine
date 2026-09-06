/** The 3D pane: its heading, the zones/mass checkbox, and the orbit hint
 *  around the Three.js view itself. */
import { IconOrbit, IconTick } from "./icons";
import { View3D } from "./View3D";
import { useStore } from "../state/store";

export function Massing() {
  const massing = useStore((s) => s.massing);
  const setMassing = useStore((s) => s.setMassing);
  const moveIn3D = useStore((s) => s.moveIn3D);
  const toggleMoveIn3D = useStore((s) => s.toggleMoveIn3D);

  return (
    <section className="massing">
      <div className="massing-head">
        <span className="label">Massing</span>
        <div className="header-sp" />
        <label className="check" title="Drag a zone to move it in plan. Off, every drag orbits the view.">
          <input type="checkbox" checked={moveIn3D} onChange={toggleMoveIn3D} />
          <span className="box">
            <IconTick size={10} />
          </span>
          Move zones
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={massing === "zones"}
            onChange={(e) => setMassing(e.target.checked ? "zones" : "mass")}
          />
          <span className="box">
            <IconTick size={10} />
          </span>
          Colour by zone
        </label>
      </div>
      <View3D />
      <div className="massing-foot">
        <IconOrbit /> Drag to orbit · scroll to zoom · click a zone to select it{moveIn3D ? " · drag it to move it" : ""}
      </div>
    </section>
  );
}

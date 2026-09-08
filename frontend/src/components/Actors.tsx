/**
 * Circulation: who walks the plan, and where.
 *
 * An actor is a name, a role and an ordered list of waypoints -- rooms it
 * visits, in order. The route between them is never edited directly: it
 * is the shortest walk of the touching graph (geometry/circulation.ts),
 * recomputed from wherever the zones are right now, the same way a door
 * arrow's suggestion is. "Record route" arms the plan to add a waypoint
 * on every zone you click next, in the order you click them; "Done" (or
 * Esc) disarms it. Nothing here is undo-covered -- an actor is an
 * analysis laid over the drawing, not a change to it.
 *
 * Two things are computed and shown, never stored: the round-trip
 * distance of each visible route, and the stretches of wall more than one
 * actor's route crosses on the storey you are looking at -- a corridor
 * pinch point or a kitchen two routes both cut through.
 */
import { useMemo, useState } from "react";

import { buildCirculationGraph, actorRoute, crossesPrivate, routeLength, sharedSegments } from "../geometry/circulation";
import type { ActorRole } from "../geometry/types";
import { zoneOf } from "../rooms";
import { useStore } from "../state/store";
import { IconEye, IconEyeOff, IconFootprints, IconWarn } from "./icons";

const ROLE_LABEL: Record<ActorRole, string> = {
  served: "Household",
  guest: "Guest",
  servant: "Staff",
  exterior: "Exterior only",
};

function AddActorForm() {
  const addActor = useStore((s) => s.addActor);
  const [name, setName] = useState("");
  const [role, setRole] = useState<ActorRole>("served");

  const submit = () => {
    addActor(name, role);
    setName("");
  };

  return (
    <div className="add-zone">
      <div className="add-zone-row">
        <input
          type="text"
          className="add-zone-name"
          placeholder="Name, e.g. Owner"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <select className="type-select" value={role} onChange={(e) => setRole(e.target.value as ActorRole)}>
          {(Object.entries(ROLE_LABEL) as [ActorRole, string][]).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <button type="button" className="ghost-btn tight" onClick={submit}>
          + Add actor
        </button>
      </div>
    </div>
  );
}

export function Actors() {
  const actors = useStore((s) => s.actors);
  const boxes = useStore((s) => s.boxes);
  const storeys = useStore((s) => s.storeys);
  const level = useStore((s) => s.level);
  const updateActor = useStore((s) => s.updateActor);
  const deleteActor = useStore((s) => s.deleteActor);
  const toggleActorVisible = useStore((s) => s.toggleActorVisible);
  const removeWaypoint = useStore((s) => s.removeWaypoint);
  const clearWaypoints = useStore((s) => s.clearWaypoints);
  const routingActorId = useStore((s) => s.routingActorId);
  const setRoutingActor = useStore((s) => s.setRoutingActor);
  const showCirculation = useStore((s) => s.showCirculation);
  const toggleCirculation = useStore((s) => s.toggleCirculation);

  const boxesById = useMemo(() => new Map(boxes.map((b) => [b.id, b])), [boxes]);
  const graph = useMemo(() => buildCirculationGraph(boxes, storeys), [boxes, storeys]);
  const info = useMemo(() => {
    const out = new Map<string, { length: number; crosses: boolean }>();
    for (const a of actors) {
      const segments = actorRoute(graph, boxes, a.waypoints);
      out.set(a.id, { length: routeLength(segments), crosses: crossesPrivate(a.role, a.waypoints, boxesById, zoneOf) });
    }
    return out;
  }, [actors, graph, boxes, boxesById]);
  const shared = useMemo(() => {
    const routes = actors.filter((a) => a.visible).map((a) => ({ actorId: a.id, segments: actorRoute(graph, boxes, a.waypoints) }));
    return sharedSegments(routes, level);
  }, [actors, graph, boxes, level]);
  const sharedNames = useMemo(() => {
    const ids = new Set(shared.flatMap((s) => s.actorIds));
    return actors.filter((a) => ids.has(a.id)).map((a) => a.name);
  }, [shared, actors]);

  return (
    <div className="actors-pane">
      <div className="actors-head">
        <div className="label">Circulation</div>
        <label className="check">
          <input type="checkbox" checked={showCirculation} onChange={toggleCirculation} />
          <span className="box">
            <IconFootprints size={10} />
          </span>
          Show on plan
        </label>
      </div>
      <AddActorForm />
      {actors.length === 0 && <p className="muted actors-empty">No actors yet. Add one above, then Record route and click zones on the plan in the order they'd walk them.</p>}
      <div className="actor-list">
        {actors.map((a) => {
          const stats = info.get(a.id) ?? { length: 0, crosses: false };
          const recording = routingActorId === a.id;
          return (
            <div key={a.id} className={`actor-row ${recording ? "recording" : ""}`}>
              <div className="actor-row-head">
                <i className="actor-swatch" style={{ background: a.color }} />
                <input
                  type="text"
                  className="name-input"
                  defaultValue={a.name}
                  key={`n${a.name}`}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== a.name) updateActor(a.id, { name: v });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
                <select className="type-select" value={a.role} onChange={(e) => updateActor(a.id, { role: e.target.value as ActorRole })}>
                  {(Object.entries(ROLE_LABEL) as [ActorRole, string][]).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="eye"
                  title={a.visible ? "Hide this route" : "Show this route"}
                  aria-label={a.visible ? "Hide this route" : "Show this route"}
                  onClick={() => toggleActorVisible(a.id)}
                >
                  {a.visible ? <IconEye /> : <IconEyeOff />}
                </button>
                <button type="button" className="icon" title="Delete actor" onClick={() => deleteActor(a.id)}>
                  ×
                </button>
              </div>
              <div className="actor-route">
                {a.waypoints.length === 0 ? (
                  <span className="muted">No route yet.</span>
                ) : (
                  a.waypoints.map((id, i) => (
                    <span key={i} className="waypoint-chip">
                      {boxesById.get(id)?.name ?? "(deleted)"}
                      <button type="button" title="Remove this stop" onClick={() => removeWaypoint(a.id, i)}>
                        ×
                      </button>
                      {i < a.waypoints.length - 1 && <span className="waypoint-arrow"> → </span>}
                    </span>
                  ))
                )}
              </div>
              <div className="actor-foot">
                <button
                  type="button"
                  className={`ghost-btn tight ${recording ? "on" : ""}`}
                  onClick={() => setRoutingActor(recording ? null : a.id)}
                >
                  {recording ? "Done recording" : "Record route"}
                </button>
                {a.waypoints.length > 0 && (
                  <button type="button" className="ghost-btn tight" onClick={() => clearWaypoints(a.id)}>
                    Clear
                  </button>
                )}
                {a.waypoints.length > 1 && <span className="num actor-dist">{stats.length.toFixed(0)} m round trip</span>}
                {stats.crosses && (
                  <span className="actor-flag" title="This route crosses a private zone">
                    <IconWarn size={12} /> crosses private
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {shared.length > 0 && (
        <p className="actors-shared">
          <IconWarn size={12} /> {shared.length} stretch{shared.length === 1 ? "" : "es"} of wall shared on this floor by{" "}
          {sharedNames.join(" and ")}.
        </p>
      )}
    </div>
  );
}

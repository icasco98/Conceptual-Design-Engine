/**
 * Circulation: who walks the plan, and where.
 *
 * An actor is a name, a role and an ordered list of waypoints -- rooms it
 * visits, in order. The route between them is never edited directly: it
 * is the shortest walk of real doors (geometry/circulation.ts), recomputed
 * from wherever the zones and arrows are right now. "Record route" arms
 * the plan to add a waypoint on every zone you click next, in the order
 * you click them; "Done" (or Esc) disarms it. Nothing here is
 * undo-covered -- an actor is an analysis laid over the drawing, not a
 * change to it.
 *
 * Three things are computed and shown, never stored: the round-trip
 * distance of each visible route; the stretches of wall more than one
 * actor's route crosses on the storey you are looking at -- a corridor
 * pinch point or a kitchen two routes both cut through; and, plainly
 * named rather than just a shorter-looking line, any leg of a route that
 * no sequence of placed doors actually connects.
 */
import { useMemo, useState } from "react";

import { buildCirculationGraph, actorRoute, outOfBounds, routeLength, sharedSegments } from "../geometry/circulation";
import type { ActorRole } from "../geometry/types";
import { zoneOf } from "../rooms";
import { useStore } from "../state/store";
import { IconEye, IconEyeOff, IconFootprints, IconWarn } from "./icons";

const ROLE_LABEL: Record<ActorRole, string> = {
  served: "Household",
  guest: "Guest",
  servant: "Staff",
  exterior: "Exterior only",
  diwaniya_guest: "Diwaniya guest",
};

/** What to call the flag when `outOfBounds` finds one, in words that say
 * what actually went wrong for that role rather than one flat phrase --
 * a diwaniya guest in the kitchen is not the same problem as staff in a
 * bedroom, even though both trip the same check. */
const OUT_OF_BOUNDS_LABEL: Record<ActorRole, string> = {
  served: "",
  guest: "enters a private zone",
  servant: "enters a private zone",
  exterior: "enters a private zone",
  diwaniya_guest: "leaves the diwaniya",
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
  const arrows = useStore((s) => s.arrows);
  const storeys = useStore((s) => s.storeys);
  const autoCarve = useStore((s) => s.autoCarve);
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
  const graph = useMemo(() => buildCirculationGraph(boxes, storeys, arrows, autoCarve), [boxes, storeys, arrows, autoCarve]);
  const info = useMemo(() => {
    const out = new Map<string, { length: number; crosses: boolean; broken: { fromId: string; toId: string }[] }>();
    for (const a of actors) {
      const { segments, broken } = actorRoute(graph, boxes, a.waypoints);
      out.set(a.id, { length: routeLength(segments), crosses: outOfBounds(a.role, a.waypoints, boxesById, zoneOf), broken });
    }
    return out;
  }, [actors, graph, boxes, boxesById]);
  const shared = useMemo(() => {
    const routes = actors.filter((a) => a.visible).map((a) => ({ actorId: a.id, segments: actorRoute(graph, boxes, a.waypoints).segments }));
    return sharedSegments(routes, level);
  }, [actors, graph, boxes, level]);
  const sharedNames = useMemo(() => {
    const ids = new Set(shared.flatMap((s) => s.actorIds));
    return actors.filter((a) => ids.has(a.id)).map((a) => a.name);
  }, [shared, actors]);
  // A diwaniya guest sharing a stretch with the household or a household
  // guest is a different order of problem than staff crossing a family
  // corridor: the whole point of the diwaniya's own entrance is that this
  // never happens, so it reads as critical rather than a routine pinch
  // point.
  const sharedCritical = useMemo(() => {
    const byId = new Map(actors.map((a) => [a.id, a]));
    return shared.some((s) => {
      const roles = s.actorIds.map((id) => byId.get(id)?.role);
      return roles.includes("diwaniya_guest") && roles.some((r) => r === "served" || r === "guest");
    });
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
          const stats = info.get(a.id) ?? { length: 0, crosses: false, broken: [] };
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
              {stats.broken.length > 0 && (
                <div className="actor-broken">
                  {stats.broken.map((leg, i) => (
                    <div key={i} className="actor-flag" title="No sequence of real doors connects these two stops">
                      <IconWarn size={12} /> No route: {boxesById.get(leg.fromId)?.name ?? "?"} &rarr; {boxesById.get(leg.toId)?.name ?? "?"}
                    </div>
                  ))}
                </div>
              )}
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
                  <span className="actor-flag" title={`This route ${OUT_OF_BOUNDS_LABEL[a.role]}`}>
                    <IconWarn size={12} /> {OUT_OF_BOUNDS_LABEL[a.role]}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {shared.length > 0 && (
        <p className={`actors-shared ${sharedCritical ? "critical" : ""}`}>
          <IconWarn size={12} />{" "}
          {sharedCritical
            ? `${sharedNames.join(" and ")} cross paths on this floor -- the reception guest is not meant to meet the household.`
            : `${shared.length} stretch${shared.length === 1 ? "" : "es"} of wall shared on this floor by ${sharedNames.join(" and ")}.`}
        </p>
      )}
    </div>
  );
}

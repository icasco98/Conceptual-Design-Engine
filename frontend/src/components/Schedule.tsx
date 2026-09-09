/**
 * The room schedule: one row per zone on the current storey, every column
 * live with the canvas in both directions. Name, type, floor, width,
 * depth and rotation are edited here and the zone follows; select a zone
 * on the plan and its row lights up, click a row and the zone is selected.
 *
 * A zone can also start here: someone who already knows the rooms they
 * want and their sizes, but has not drawn anything yet, types a name,
 * type and size into the form at the top and it appears as a row with
 * nowhere to be. Its own table -- "To place" -- lists these until each
 * is dropped onto the plan: "Place" arms the `place` tool, and clicking
 * the sheet gives it a position exactly as drawing a rectangle would.
 * Until then it has no area, no rotation, no priority and is invisible
 * everywhere geometry is computed (geometry/snap.ts, `liveBoxes`).
 *
 * A zone goes the other way too: × on a placed row (or its plan
 * equivalent) does not delete it, it takes it off the plan and drops it
 * back into "To place" -- cleaning up a layout is not the same as
 * throwing the rooms away. × on a "To place" row deletes it for real,
 * since there is nowhere else for it to go back to.
 */
import { useMemo, useState } from "react";

import { displayShapes } from "../geometry/carve";
import { polyArea } from "../geometry/poly";
import { isOpenToBelow, liveBoxes } from "../geometry/snap";
import type { Box, BoxShape, PrivacyTier } from "../geometry/types";
import { fillFor } from "../palette";
import { ROOM_TYPES, roomTypeInfo, tierOf } from "../rooms";
import { useStore } from "../state/store";
import { IconCircle, IconRect } from "./icons";

function floorLabel(i: number): string {
  return i === 0 ? "G" : String(i);
}

const PRIVACY_TIER_LABEL: Record<PrivacyTier, string> = { public: "Public", "semi-public": "Semi-public", private: "Private" };

/** The privacy-override picker, next to Type: blank means "use this
 * room's own type default" (rooms.ts's `tier`) -- almost every row stays
 * on that. Set only for the rare instance that needs to diverge, such as
 * a dining room a household also opens to its diwaniya. Shown even for a
 * type with no default at all (a bathroom, a service room) since an
 * override can still give one specific instance a tier the type itself
 * doesn't carry. */
function PrivacyTierSelect({ box, onSelect, onChange }: { box: Box; onSelect: () => void; onChange: (tier: PrivacyTier | undefined) => void }) {
  const typeDefault = tierOf(box.roomType);
  return (
    <select
      className="type-select"
      value={box.privacyTierOverride ?? ""}
      title={`Privacy level for the public-to-private check. Leave as default to use ${typeDefault ? PRIVACY_TIER_LABEL[typeDefault] : "this type's own (none)"}.`}
      onFocus={onSelect}
      onChange={(e) => onChange(e.target.value ? (e.target.value as PrivacyTier) : undefined)}
    >
      <option value="">{typeDefault ? `Default (${PRIVACY_TIER_LABEL[typeDefault]})` : "Default (none)"}</option>
      <option value="public">{PRIVACY_TIER_LABEL.public}</option>
      <option value="semi-public">{PRIVACY_TIER_LABEL["semi-public"]}</option>
      <option value="private">{PRIVACY_TIER_LABEL.private}</option>
    </select>
  );
}

/** Name, type, size and shape for a zone not yet on the plan. Typical
 *  width/depth for the chosen type fill in as soon as it is picked, and
 *  stay editable from there -- a starting guess, not a constraint. */
function AddZoneForm() {
  const addUnplacedBox = useStore((s) => s.addUnplacedBox);
  const [name, setName] = useState("");
  const [roomType, setRoomType] = useState("other");
  const [shape, setShape] = useState<BoxShape>("rect");
  const [width, setWidth] = useState(roomTypeInfo("other").typicalWidth);
  const [height, setHeight] = useState(roomTypeInfo("other").typicalHeight);

  const onType = (rt: string) => {
    setRoomType(rt);
    const info = roomTypeInfo(rt);
    setWidth(info.typicalWidth);
    setHeight(info.typicalHeight);
  };

  const submit = () => {
    addUnplacedBox(roomType, name, width, height, shape);
    setName("");
  };

  return (
    <div className="add-zone">
      <div className="label">Add a zone</div>
      <div className="add-zone-row">
        <input
          type="text"
          className="add-zone-name"
          placeholder="Name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <select className="type-select" value={roomType} onChange={(e) => onType(e.target.value)}>
          {Object.entries(ROOM_TYPES).map(([key, info]) => (
            <option key={key} value={key}>
              {info.label}
            </option>
          ))}
        </select>
        <input
          type="number"
          step="0.05"
          min="0.1"
          title="Width (m)"
          value={width}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (isFinite(v) && v > 0) setWidth(v);
          }}
        />
        <input
          type="number"
          step="0.05"
          min="0.1"
          title="Depth (m)"
          value={height}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (isFinite(v) && v > 0) setHeight(v);
          }}
        />
        <button
          type="button"
          className={`icon-toggle ${shape === "rect" ? "on" : ""}`}
          title="Rectangle"
          aria-label="Rectangle"
          onClick={() => setShape("rect")}
        >
          <IconRect size={14} />
        </button>
        <button
          type="button"
          className={`icon-toggle ${shape === "circle" ? "on" : ""}`}
          title="Circle"
          aria-label="Circle"
          onClick={() => setShape("circle")}
        >
          <IconCircle size={14} />
        </button>
        <button type="button" className="ghost-btn tight" onClick={submit}>
          + Add
        </button>
      </div>
    </div>
  );
}

export function Schedule() {
  const boxes = useStore((s) => s.boxes);
  const level = useStore((s) => s.level);
  const storeys = useStore((s) => s.storeys);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const deleteBoxes = useStore((s) => s.deleteBoxes);
  const unplaceBoxes = useStore((s) => s.unplaceBoxes);
  const updateBox = useStore((s) => s.updateBox);
  const carve = useStore((s) => s.carve);
  const release = useStore((s) => s.release);
  const autoCarve = useStore((s) => s.autoCarve);
  const beginPlacement = useStore((s) => s.beginPlacement);

  const live = useMemo(() => liveBoxes(boxes, level), [boxes, level]);
  const unplaced = useMemo(() => boxes.filter((b) => !b.deleted && b.placed === false && b.level === level), [boxes, level]);
  const shapes = useMemo(() => displayShapes(live, autoCarve), [live, autoCarve]);
  const carvesSomething = (b: Box) => live.some((o) => o.carvedBy.includes(b.id));
  const areaOf = (b: Box) => {
    const s = shapes.find((x) => x.id === b.id);
    return s ? polyArea(s.page) : b.width * b.height;
  };

  /** Resize about the zone's own centre, so a number typed here does not
   *  also move it. Through updateBox, so it joins the undo history. */
  const edit = (b: Box, axis: "w" | "h", meters: number) => {
    if (!isFinite(meters) || meters <= 0) return;
    if (axis === "w") {
      const w = Math.max(b.minWidth, meters);
      updateBox(b.id, { left: b.left + (b.width - w) / 2, width: w });
    } else {
      const h = Math.max(b.minHeight, meters);
      updateBox(b.id, { top: b.top + (b.height - h) / 2, height: h });
    }
  };

  const editRotation = (b: Box, degrees: number) => {
    if (!isFinite(degrees)) return;
    updateBox(b.id, { rotation: ((Math.round(degrees) % 360) + 360) % 360 });
  };

  return (
    <div className="schedule">
      <AddZoneForm />
      <table>
        <thead>
          <tr>
            <th>Space</th>
            <th>Type</th>
            <th title="How private this room is for the public-to-private door check. Default follows the type; override only the rare instance that needs to differ.">Privacy</th>
            <th>Floor</th>
            <th className="r">Width</th>
            <th className="r">Depth</th>
            <th className="r" title="Vertical height. Taller than a storey and the zone reaches the storey above.">Height</th>
            <th className="r">Area</th>
            <th className="r">Rot.</th>
            <th className="r" title="1 is the highest. With automatic carving on, a zone is carved by anything it overlaps that outranks it.">
              Pri.
            </th>
            <th />
            <th />
          </tr>
        </thead>
        {unplaced.length > 0 && (
          <tbody className="unplaced">
            <tr className="section-row">
              <td colSpan={12}>To place ({unplaced.length})</td>
            </tr>
            {unplaced.map((b) => (
              <tr key={b.id} className={selected.includes(b.id) ? "selected" : ""} onClick={() => select(b.id)}>
                <td className="name">
                  <i style={{ background: fillFor(b.roomType, b.kind), borderRadius: b.shape === "circle" ? "50%" : 2 }} />
                  <input
                    type="text"
                    className="name-input"
                    defaultValue={b.name}
                    key={`n${b.name}`}
                    onFocus={() => select(b.id)}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== b.name) updateBox(b.id, { name: v });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                  />
                </td>
                <td>
                  <select
                    className="type-select"
                    value={b.roomType}
                    title={ROOM_TYPES[b.roomType]?.label}
                    onFocus={() => select(b.id)}
                    onChange={(e) => updateBox(b.id, { roomType: e.target.value })}
                  >
                    {Object.entries(ROOM_TYPES).map(([key, info]) => (
                      <option key={key} value={key}>
                        {info.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <PrivacyTierSelect box={b} onSelect={() => select(b.id)} onChange={(tier) => updateBox(b.id, { privacyTierOverride: tier })} />
                </td>
                <td>
                  <select
                    className="floor-select"
                    value={b.level}
                    onFocus={() => select(b.id)}
                    onChange={(e) => {
                      const lv = parseInt(e.target.value, 10);
                      updateBox(b.id, { level: lv, levelTo: lv });
                    }}
                  >
                    {Array.from({ length: storeys }, (_, i) => (
                      <option key={i} value={i}>
                        {floorLabel(i)}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="r">
                  <input
                    type="number"
                    step="0.05"
                    min={b.minWidth.toFixed(2)}
                    defaultValue={b.width.toFixed(2)}
                    key={`w${b.width.toFixed(3)}`}
                    onFocus={() => select(b.id)}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (isFinite(v) && v > 0) updateBox(b.id, { width: Math.max(b.minWidth, v) });
                    }}
                  />
                </td>
                <td className="r">
                  <input
                    type="number"
                    step="0.05"
                    min={b.minHeight.toFixed(2)}
                    defaultValue={b.height.toFixed(2)}
                    key={`h${b.height.toFixed(3)}`}
                    onFocus={() => select(b.id)}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (isFinite(v) && v > 0) updateBox(b.id, { height: Math.max(b.minHeight, v) });
                    }}
                  />
                </td>
                <td className="r num muted" title="Not set until placed">–</td>
                <td className="r num muted" title="No position yet">–</td>
                <td className="r num muted">–</td>
                <td className="r num muted">–</td>
                <td>
                  <button type="button" className="ghost-btn tight" title="Place this zone on the plan" onClick={() => beginPlacement(b.id)}>
                    Place
                  </button>
                </td>
                <td>
                  <button type="button" className="icon" title="Delete" onClick={() => deleteBoxes([b.id])}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        )}
        <tbody>
          {live.map((b) => {
            const shape = shapes.find((s) => s.id === b.id);
            const carved = shape?.carved;
            const flagged = shape?.flagged;
            const carving = carvesSomething(b);
            const spans = b.levelTo > b.level;
            const openBelow = isOpenToBelow(b, level);
            return (
              <tr
                key={b.id}
                className={`${selected.includes(b.id) ? "selected" : ""} ${flagged ? "flagged" : ""} ${openBelow ? "open-below" : ""}`}
                onClick={(e) => {
                  const t = e.target as HTMLElement;
                  if (t.tagName === "INPUT" || t.tagName === "BUTTON" || t.tagName === "SELECT") return;
                  select(b.id, e.shiftKey);
                }}
              >
                <td className="name">
                  <i style={{ background: fillFor(b.roomType, b.kind), borderRadius: b.shape === "circle" ? "50%" : 2 }} />
                  <input
                    type="text"
                    className="name-input"
                    defaultValue={b.name}
                    key={`n${b.name}`}
                    onFocus={() => select(b.id)}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== b.name) updateBox(b.id, { name: v });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                  />
                </td>
                <td>
                  <select
                    className="type-select"
                    value={b.roomType}
                    title={ROOM_TYPES[b.roomType]?.label}
                    onFocus={() => select(b.id)}
                    onChange={(e) => updateBox(b.id, { roomType: e.target.value })}
                  >
                    {Object.entries(ROOM_TYPES).map(([key, info]) => (
                      <option key={key} value={key}>
                        {info.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <PrivacyTierSelect box={b} onSelect={() => select(b.id)} onChange={(tier) => updateBox(b.id, { privacyTierOverride: tier })} />
                </td>
                <td>
                  {spans ? (
                    <span className="num" title="Spans several storeys">
                      {floorLabel(b.level)}–{floorLabel(b.levelTo)}
                    </span>
                  ) : (
                    <select
                      className="floor-select"
                      value={b.level}
                      onFocus={() => select(b.id)}
                      onChange={(e) => updateBox(b.id, { level: parseInt(e.target.value, 10) })}
                    >
                      {Array.from({ length: storeys }, (_, i) => (
                        <option key={i} value={i}>
                          {floorLabel(i)}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td className="r">
                  <input
                    type="number"
                    step="0.05"
                    min={b.minWidth.toFixed(2)}
                    defaultValue={b.width.toFixed(2)}
                    key={`w${b.width.toFixed(3)}`}
                    onFocus={() => select(b.id)}
                    onChange={(e) => edit(b, "w", parseFloat(e.target.value))}
                  />
                </td>
                <td className="r">
                  <input
                    type="number"
                    step="0.05"
                    min={b.minHeight.toFixed(2)}
                    defaultValue={b.height.toFixed(2)}
                    key={`h${b.height.toFixed(3)}`}
                    onFocus={() => select(b.id)}
                    onChange={(e) => edit(b, "h", parseFloat(e.target.value))}
                  />
                </td>
                <td className="r">
                  <input
                    type="number"
                    step="0.1"
                    min="0.5"
                    defaultValue={b.heightM.toFixed(1)}
                    key={`z${b.heightM.toFixed(2)}`}
                    title="Height in m"
                    onFocus={() => select(b.id)}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (isFinite(v) && v >= 0.5) updateBox(b.id, { heightM: v });
                    }}
                  />
                </td>
                <td
                  className={`r num ${flagged ? "flag" : carved ? "carved" : ""}`}
                  title={openBelow ? "Open to below: this zone's floor is the storey underneath" : flagged ? "Carved below its minimum size, or cut in two" : carved ? "Carved by another zone" : ""}
                >
                  {openBelow ? "void" : `${flagged ? "! " : ""}${areaOf(b).toFixed(1)}`}
                </td>
                <td className="r">
                  <input
                    type="number"
                    step="1"
                    className="rot"
                    defaultValue={b.rotation}
                    key={`r${b.rotation}`}
                    onFocus={() => select(b.id)}
                    onChange={(e) => editRotation(b, parseFloat(e.target.value))}
                  />
                </td>
                <td className="r">
                  <input
                    type="number"
                    step="1"
                    min="1"
                    className="rot"
                    defaultValue={b.priority}
                    key={`p${b.priority}`}
                    title="Priority: 1 is the highest"
                    onFocus={() => select(b.id)}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (isFinite(v) && v >= 1) updateBox(b.id, { priority: v });
                    }}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className={`carve-btn ${carving ? "on" : ""}`}
                    title={carving ? "Release: stop carving the zones under this one" : "Carve the zones under this one"}
                    aria-label={carving ? "Release the carve" : "Carve"}
                    onClick={() => (carving ? release(b.id) : carve(b.id))}
                  >
                    {carving ? "⊟" : "⊠"}
                  </button>
                </td>
                <td>
                  <button
                    type="button"
                    className="icon"
                    title="Take off the plan (stays here, ready to place again)"
                    onClick={() => unplaceBoxes(selected.includes(b.id) && selected.length > 1 ? selected : [b.id])}
                  >
                    ×
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="schedule-foot muted">
        Width, depth and height in m, area in m², rotation in degrees. A zone taller than 3.0 m reaches the storey above.
        Priority 1 is the highest; it decides which zone gives way when automatic carving is on. Privacy follows the room
        type by default -- leave it as Default unless this one instance genuinely needs to differ.
      </p>
    </div>
  );
}

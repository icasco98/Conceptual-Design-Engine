"""Interactive drag canvas: the *only* zoning diagram this tool renders.

It shows Claude's recommended room grouping and layout (src.layout,
src.layout_plan) — title, color-coded legend, and rationale included — as
draggable, resizable, rotatable, deletable boxes the owner can rearrange by
hand to explore a different arrangement. Corridors are draggable exactly
like rooms (nothing here is a fixed zone); the site outline, the buildable
envelope (setback) outline, the building footprint, the street marker, and
door arrows are the only static-position backdrop — everything else
recomputes live as boxes move (see below).

Per-box controls, all pure client-side JS (see the generated `<script>`):

- **Drag** the body of a box to move it (`onDown`/`onMove`).
- **Drag a corner handle** to resize it (`onResizeDown`/`doResize`) —
  the opposite corner stays put.
- **Drag the rotate handle** to spin it in fixed 5° steps (`onRotateDown`/
  `doRotate`). Rotation is a CSS `transform` for rendering, but its
  *collision footprint* is the rotated shape's axis-aligned bounding box
  (`effectiveRectOf`) — so rotating a box does push its neighbors out of
  the way and does grow the building footprint, without needing full
  rotated-rectangle (SAT) collision geometry.
- **Click the delete handle** to remove a box (`onDeleteDown`) — it's
  hidden (not destroyed) so "Reset to recommended layout" can always bring
  it back.
- **The grid checkbox** toggles a faint 0.25m reference grid
  (`#grid-overlay`). Independent of that toggle, every box's position
  always snaps to that same 0.25m grid while dragging or resizing
  (`snapToGrid`, `GRID_PX`) — the grid is a visibility choice, snapping
  isn't.

Three constraints hold at all times while dragging, resizing, or rotating,
enforced client-side in the generated JS (never round-tripped through
Python):

1. **No overlaps, ever — not even for the box you're holding.**
   `resolveOverlaps` runs three strategies together, every round: every
   *other* box shrinks toward its own minimum size and/or is pushed out
   of the way of whatever it overlaps (`shrinkAndPushNonPinned`,
   cascading further if needed); the box under the owner's cursor, never
   touched by that, gets nudged (position only, never resized) if a
   neighbor genuinely had nowhere left to go and still overlaps it
   (`pushPinnedClearOfOverlaps`); and finally, whatever still overlaps
   after both of those — a dense enough scene can leave the gentler
   one-box-at-a-time heuristics cycling instead of settling — gets split
   apart unconditionally, half the separation to each side
   (`forceSeparateAnyRemainingOverlaps`). Running all three every round,
   not just the first two until they give up, is what makes "no overlaps"
   an actual invariant rather than a best effort that quietly fails in a
   crowded corner.
2. **The setback line is a hard wall.** Every box is kept inside the
   buildable envelope (`data-env-*` on #canvas-container) — an unrotated
   box shrinks toward its own minimum before crossing it; a rotated box
   (whose true shape isn't axis-aligned) is translated instead, since
   shrinking its underlying rectangle while rotated would distort it.
3. **Rooms may shrink, never below their minimum.** Same minimums as the
   initial packer's own compaction (`src/layout.py`) — `data-min-width`/
   `data-min-height`, from `src/defaults.py` for rooms and the fixed code
   hallway width for corridors.

Two things are recomputed from scratch after every move, resize, rotate,
or delete (`refreshDiagram`), never left stale from the initial layout:

- **The building footprint outline** — the live union of every current
  box's *effective* (rotation-aware) rect (`computeFootprintPath`).
- **The door arrows** — one per shared wall between boxes that are
  actually touching right now, found by re-walking the touching-graph
  breadth-first from the entry (`computeDoorArrowSegments`, the same
  algorithm `src/layout.py` uses for the initial recommendation, ported to
  JS) and drawn with an arrowhead marker. Unlike the footprint, this uses
  each box's true (unrotated) rect — a door is a literal wall opening, not
  a safety margin, so a merely-rotated room shouldn't spuriously "touch" a
  neighbor it doesn't actually share a wall with.

Rendered as a single self-contained HTML/CSS/JS document via
`streamlit.components.v1.html` — plain absolutely-positioned `<div>`s
dragged with vanilla pointer events, entirely inside the browser. There is
deliberately no channel feeding drag state back into Python: an earlier
version tried to keep a third-party canvas component's state in sync with
Streamlit across every rerun, and the round trip was exactly what caused
the flicker/reset the owner reported ("switching between the original
shape and the modified shape"). A page that never sends anything back to
Python during a drag has nothing to desync — dragging is instant, and a
"Reset" button (also pure client-side JS) snaps position, size, rotation,
and deleted-state all back to Claude's recommended layout, stored in each
box's own data attributes.
"""

from __future__ import annotations

import html as html_module
from typing import Dict, List, Tuple

from src.geometry import BuildableEnvelope
from src.layout import LayoutResult
from src.layout_plan import CategoryLabels, LayoutPlan
from src.models import Project, Site
from src.palette import CATEGORY_COLORS

PX_PER_METER = 26.0
MARGIN_PX = 34.0
STREET_LABEL_HEADROOM_PX = 20.0
FONT_STACK = "'Helvetica Neue', Helvetica, Arial, sans-serif"
CANVAS_BACKGROUND = "#fbfbf9"

# Every box's position snaps to this grid while dragging or resizing,
# regardless of whether the grid overlay is visible (see #grid-toggle).
GRID_M = 0.25
GRID_PX = GRID_M * PX_PER_METER

# How far each door arrow's endpoints sit from the wall it crosses — same
# value src/layout.py's _perpendicular_arrow uses, in meters.
DOOR_INSET_M = 0.35
DOOR_INSET_PX = DOOR_INSET_M * PX_PER_METER

# Corner-resize handles, a rotate handle (5° increments — see the module
# docstring for how rotation still affects neighbors despite being a CSS
# transform), and a delete handle, appended into every room/corridor div.
# Static markup, no per-room data.
_HANDLES_HTML = (
    '<span class="resize-handle nw" data-corner="nw"></span>'
    '<span class="resize-handle ne" data-corner="ne"></span>'
    '<span class="resize-handle sw" data-corner="sw"></span>'
    '<span class="resize-handle se" data-corner="se"></span>'
    '<span class="rotate-handle" title="Rotate (5° steps)">&#8635;</span>'
    '<span class="delete-handle" title="Delete">&times;</span>'
)


def canvas_size_px(site: Site) -> Tuple[int, int]:
    return (
        int(site.width_m * PX_PER_METER + 2 * MARGIN_PX),
        int(site.depth_m * PX_PER_METER + 2 * MARGIN_PX + STREET_LABEL_HEADROOM_PX),
    )


def _to_canvas_point(x_m: float, y_m: float, site_depth_m: float) -> Tuple[float, float]:
    """Site-frame meters -> canvas pixels for a single point. Canvas y
    grows downward; site y grows toward the front, so this flips y to
    keep front-at-top, matching the static diagram's orientation."""
    return (
        MARGIN_PX + x_m * PX_PER_METER,
        MARGIN_PX + STREET_LABEL_HEADROOM_PX + (site_depth_m - y_m) * PX_PER_METER,
    )


def _to_canvas_rect(x_m: float, y_m: float, w_m: float, d_m: float, site_depth_m: float) -> Tuple[float, float, float, float]:
    """Site-frame meters -> canvas pixels for a rectangle's top-left + size."""
    left, bottom = _to_canvas_point(x_m, y_m, site_depth_m)
    return left, bottom - d_m * PX_PER_METER, w_m * PX_PER_METER, d_m * PX_PER_METER


_EDGE_LINE = {
    "front": lambda w, d: ((0, 0), (w, 0)),
    "back": lambda w, d: ((0, d), (w, d)),
    "left": lambda w, d: ((0, 0), (0, d)),
    "right": lambda w, d: ((w, 0), (w, d)),
}
_EDGE_LABEL_ANCHOR = {
    "front": lambda w, d: (w / 2, -16),
    "back": lambda w, d: (w / 2, d + 4),
    "left": lambda w, d: (-30, d / 2),
    "right": lambda w, d: (w + 4, d / 2),
}


def _esc(text: str) -> str:
    return html_module.escape(text, quote=True)


def _path_d(canvas_points: List[Tuple[float, float]]) -> str:
    """Ordered polygon vertices (canvas px) -> an SVG path `d` string. Used
    for the footprint outline both on first render (from `result.footprint`)
    and — in the same format — by the client-side JS that recomputes it as
    the owner drags (`computeFootprintPath` builds the identical `M ... Z`
    shape from the live box positions)."""
    if not canvas_points:
        return ""
    body = " L ".join(f"{x:.1f},{y:.1f}" for x, y in canvas_points)
    return f"M {body} Z"


def _envelope_canvas_rect(project: Project, envelope: BuildableEnvelope) -> Tuple[float, float, float, float]:
    return _to_canvas_rect(
        envelope.left_setback_m, envelope.back_setback_m, envelope.width_m, envelope.depth_m, project.site.depth_m
    )


def _static_svg(project: Project, envelope: BuildableEnvelope, result: LayoutResult) -> str:
    """The faint 0.25m reference grid (`#grid-overlay`, hidden until the
    checkbox is ticked), the site outline (property line), the buildable
    envelope outline (the setback line), the building footprint outline
    (id="footprint-shape", overwritten live by JS as boxes move/rotate),
    the street marker(s), and door arrows (`#door-arrows-group`, rebuilt
    live by JS from whichever boxes are actually touching right now) —
    one non-interactive SVG layer under the room/corridor boxes."""
    site = project.site
    width_px = site.width_m * PX_PER_METER
    depth_px = site.depth_m * PX_PER_METER
    top = MARGIN_PX + STREET_LABEL_HEADROOM_PX
    total_w = width_px + 2 * MARGIN_PX
    total_h = depth_px + 2 * MARGIN_PX + STREET_LABEL_HEADROOM_PX

    defs = (
        "<defs>"
        f'<pattern id="grid-pattern" width="{GRID_PX}" height="{GRID_PX}" patternUnits="userSpaceOnUse">'
        f'<path d="M {GRID_PX} 0 L 0 0 0 {GRID_PX}" fill="none" stroke="#d8d8d2" stroke-width="0.6" />'
        "</pattern>"
        '<marker id="door-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" '
        'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#1a1a1a" fill-opacity="0.6" /></marker>'
        "</defs>"
    )

    parts = [
        defs,
        f'<rect id="grid-overlay" x="0" y="0" width="{total_w}" height="{total_h}" '
        f'fill="url(#grid-pattern)" style="display:none;" />',
        f'<rect x="{MARGIN_PX}" y="{top}" width="{width_px}" height="{depth_px}" '
        f'rx="4" fill="none" stroke="#a8a8a3" stroke-width="1.5" />',
    ]

    env_left, env_top, env_w, env_h = _envelope_canvas_rect(project, envelope)
    parts.append(
        f'<rect x="{env_left:.1f}" y="{env_top:.1f}" width="{env_w:.1f}" height="{env_h:.1f}" '
        f'fill="none" stroke="#c9a15a" stroke-width="1.5" stroke-dasharray="6 4" />'
    )

    initial_d = _path_d([_to_canvas_point(x, y, site.depth_m) for x, y in result.footprint])
    parts.append(
        f'<path id="footprint-shape" d="{initial_d}" fill="rgba(58,58,53,0.06)" '
        f'stroke="#3a3a35" stroke-width="2.5" stroke-linejoin="round" fill-rule="evenodd" />'
    )

    door_parts = []
    for (x0, y0), (x1, y1) in result.circulation_edges:
        cx0, cy0 = _to_canvas_point(x0, y0, site.depth_m)
        cx1, cy1 = _to_canvas_point(x1, y1, site.depth_m)
        door_parts.append(
            f'<line x1="{cx0:.1f}" y1="{cy0:.1f}" x2="{cx1:.1f}" y2="{cy1:.1f}" '
            f'stroke="#1a1a1a" stroke-width="1.6" stroke-opacity="0.55" marker-end="url(#door-arrow)" />'
        )
    parts.append(f'<g id="door-arrows-group">{"".join(door_parts)}</g>')

    for edge in site.edges:
        if edge.adjacency != "street":
            continue
        (x0, y0), (x1, y1) = _EDGE_LINE[edge.position](width_px, depth_px)
        parts.append(
            f'<line x1="{MARGIN_PX + x0}" y1="{top + y0}" x2="{MARGIN_PX + x1}" y2="{top + y1}" '
            f'stroke="#c0392b" stroke-width="4" stroke-linecap="round" />'
        )
        lx, ly = _EDGE_LABEL_ANCHOR[edge.position](width_px, depth_px)
        anchor = "middle" if edge.position in ("front", "back") else ("end" if edge.position == "left" else "start")
        parts.append(
            f'<text x="{MARGIN_PX + lx}" y="{top + ly}" fill="#c0392b" font-weight="700" '
            f'font-size="11" font-family="{FONT_STACK}" text-anchor="{anchor}">STREET</text>'
        )

    return f'<svg id="static-svg" width="{total_w}" height="{total_h}" style="position:absolute;top:0;left:0;pointer-events:none;">{"".join(parts)}</svg>'


def _corridor_divs(project: Project, result: LayoutResult) -> str:
    """Corridors are draggable/resizable/rotatable/deletable exactly like
    rooms — see the module docstring — so they share `.draggable`, the
    resize/rotate/delete handles, and the same data attributes that hold
    each box's recommended (reset) position AND size. A corridor's minimum
    on both axes is the fixed code hallway width itself — see
    `CorridorSegment.min_width_m`/`min_depth_m`."""
    divs = []
    for i, corridor in enumerate(result.corridors):
        left, top, w, h = _to_canvas_rect(corridor.x_m, corridor.y_m, corridor.width_m, corridor.depth_m, project.site.depth_m)
        min_w_px = corridor.min_width_m * PX_PER_METER
        min_h_px = corridor.min_depth_m * PX_PER_METER
        divs.append(
            f'<div class="corridor draggable" '
            f'style="left:{left:.1f}px;top:{top:.1f}px;width:{w:.1f}px;height:{h:.1f}px;" '
            f'data-initial-left="{left:.1f}" data-initial-top="{top:.1f}" '
            f'data-initial-width="{w:.1f}" data-initial-height="{h:.1f}" '
            f'data-min-width="{min_w_px:.1f}" data-min-height="{min_h_px:.1f}">'
            f'<span class="label corridor-label">Hallway</span>'
            f"{_HANDLES_HTML}"
            f"</div>"
        )
    return "".join(divs)


def _room_divs(project: Project, result: LayoutResult, assignments: Dict[str, str]) -> str:
    divs = []
    for room in result.rooms:
        left, top, w, h = _to_canvas_rect(room.x_m, room.y_m, room.width_m, room.depth_m, project.site.depth_m)
        color = CATEGORY_COLORS.get(assignments.get(room.base_name, "category_a"), "#cccccc")
        entry_class = " entry" if room.is_entry else ""
        min_w_px = room.min_width_m * PX_PER_METER
        min_h_px = room.min_depth_m * PX_PER_METER
        divs.append(
            f'<div class="room-box draggable{entry_class}" '
            f'style="left:{left:.1f}px;top:{top:.1f}px;width:{w:.1f}px;height:{h:.1f}px;background:{color};" '
            f'data-initial-left="{left:.1f}" data-initial-top="{top:.1f}" '
            f'data-initial-width="{w:.1f}" data-initial-height="{h:.1f}" '
            f'data-min-width="{min_w_px:.1f}" data-min-height="{min_h_px:.1f}">'
            f'<span class="label">{_esc(room.name)}</span>'
            f"{_HANDLES_HTML}"
            f"</div>"
        )
    return "".join(divs)


def _legend_html(category_labels: CategoryLabels) -> str:
    """Category swatches plus the fixed markers (Hallway, Entry, Door)
    that aren't a 4th color — see src.palette for why."""
    items = []
    for key in ("category_a", "category_b", "category_c"):
        label = getattr(category_labels, key)
        color = CATEGORY_COLORS[key]
        items.append(
            f'<span class="legend-item"><span class="swatch" style="background:{color};"></span>{_esc(label)}</span>'
        )
    items.append('<span class="legend-item"><span class="swatch corridor-swatch"></span>Hallway</span>')
    items.append('<span class="legend-item"><span class="swatch entry-swatch"></span>Entry</span>')
    items.append('<span class="legend-item"><span class="door-swatch">&#8594;</span>Door</span>')
    return "".join(items)


def render_canvas_html(
    project: Project,
    envelope: BuildableEnvelope,
    result: LayoutResult,
    assignments: Dict[str, str],
    layout_plan: LayoutPlan,
) -> str:
    width_px, height_px = canvas_size_px(project.site)
    env_left, env_top, env_w, env_h = _envelope_canvas_rect(project, envelope)
    env_right = env_left + env_w
    env_bottom = env_top + env_h

    return f"""
<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body {{
    margin: 0; padding: 0;
    background: {CANVAS_BACKGROUND};
    font-family: {FONT_STACK};
  }}
  #canvas-header {{
    padding: 2px 4px 10px 4px;
  }}
  .canvas-title {{
    margin: 0 0 8px 0;
    font-size: 17px;
    font-weight: 700;
    color: #1a1a1a;
  }}
  .canvas-legend {{
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 14px;
  }}
  .legend-item {{
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #333333;
  }}
  .swatch {{
    width: 14px;
    height: 14px;
    border-radius: 3px;
    display: inline-block;
    border: 1px solid rgba(0,0,0,0.25);
  }}
  .corridor-swatch {{
    background-image: repeating-linear-gradient(45deg, #dcdcd6 0, #dcdcd6 3px, #f2f2ee 3px, #f2f2ee 7px);
    border: 1px dashed #b9b9b3;
  }}
  .entry-swatch {{
    background: #ffffff;
    border: 2px dashed #0b0b0b;
  }}
  .door-swatch {{
    font-size: 14px;
    font-weight: 700;
    color: #1a1a1a;
    line-height: 14px;
  }}
  .grid-toggle-label {{
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: #333333;
    cursor: pointer;
    user-select: none;
    margin-left: 4px;
  }}
  .canvas-rationale {{
    margin: 10px 4px 0 4px;
    font-size: 12.5px;
    color: #55554f;
    max-width: {width_px}px;
    line-height: 1.4;
  }}
  #canvas-container {{
    position: relative;
    width: {width_px}px;
    height: {height_px}px;
    background: {CANVAS_BACKGROUND};
  }}
  .draggable {{
    position: absolute;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
    touch-action: none;
    padding: 3px;
    transition: box-shadow 0.15s ease;
    z-index: 1;
  }}
  .draggable.dragging {{
    cursor: grabbing;
    box-shadow: 0 7px 16px rgba(15,23,42,0.35);
    z-index: 50;
    transition: none;
  }}
  .draggable.deleted {{
    display: none;
  }}
  .corridor {{
    border: 1px dashed #b9b9b3;
    background-image: repeating-linear-gradient(45deg, #dcdcd6 0, #dcdcd6 4px, #f2f2ee 4px, #f2f2ee 10px);
  }}
  .room-box {{
    border-radius: 8px;
    border: 1px solid rgba(0,0,0,0.35);
    box-shadow: 0 3px 7px rgba(15,23,42,0.22);
  }}
  .room-box.entry {{
    border: 2.5px dashed #0b0b0b;
  }}
  .label {{
    background: rgba(255,255,255,0.55);
    border-radius: 3px;
    padding: 1px 4px;
    font-size: 13px;
    font-weight: 600;
    color: #111111;
    line-height: 1.15;
  }}
  .corridor-label {{
    font-size: 10px;
    color: #55554f;
  }}
  .resize-handle {{
    position: absolute;
    width: 9px;
    height: 9px;
    background: #ffffff;
    border: 1.5px solid #333333;
    border-radius: 2px;
    opacity: 0.55;
    z-index: 60;
    touch-action: none;
  }}
  .draggable:hover .resize-handle {{ opacity: 1; }}
  .resize-handle.nw {{ top: -5px; left: -5px; cursor: nwse-resize; }}
  .resize-handle.ne {{ top: -5px; right: -5px; cursor: nesw-resize; }}
  .resize-handle.sw {{ bottom: -5px; left: -5px; cursor: nesw-resize; }}
  .resize-handle.se {{ bottom: -5px; right: -5px; cursor: nwse-resize; }}
  .rotate-handle {{
    position: absolute;
    top: -22px;
    left: 50%;
    transform: translateX(-50%);
    width: 15px;
    height: 15px;
    border-radius: 50%;
    background: #ffffff;
    border: 1.5px solid #333333;
    opacity: 0.55;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    line-height: 1;
    cursor: grab;
    touch-action: none;
  }}
  .draggable:hover .rotate-handle {{ opacity: 1; }}
  .delete-handle {{
    position: absolute;
    top: -9px;
    right: -9px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #c0392b;
    color: #ffffff;
    font-size: 12px;
    line-height: 16px;
    text-align: center;
    opacity: 0.55;
    z-index: 61;
    cursor: pointer;
    touch-action: none;
  }}
  .draggable:hover .delete-handle {{ opacity: 0.9; }}
  .delete-handle:hover {{ opacity: 1; background: #a5301f; }}
  #reset-btn {{
    margin-top: 10px;
    font-family: {FONT_STACK};
    font-size: 13px;
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid #ccc;
    background: #ffffff;
    cursor: pointer;
  }}
  #reset-btn:hover {{ background: #f2f2f0; }}
</style>
</head>
<body>
  <div id="canvas-header">
    <h2 class="canvas-title">{_esc(layout_plan.grouping_label)}</h2>
    <div class="canvas-legend">
      {_legend_html(layout_plan.category_labels)}
      <label class="grid-toggle-label"><input type="checkbox" id="grid-toggle" /> Show {GRID_M:g}m grid</label>
    </div>
  </div>
  <div id="canvas-container" data-env-left="{env_left:.1f}" data-env-top="{env_top:.1f}" data-env-right="{env_right:.1f}" data-env-bottom="{env_bottom:.1f}">
    {_static_svg(project, envelope, result)}
    {_corridor_divs(project, result)}
    {_room_divs(project, result, assignments)}
  </div>
  <button id="reset-btn" type="button">Reset to recommended layout</button>
  <p class="canvas-rationale">{_esc(layout_plan.rationale)}</p>

<script>
(function() {{
  var GRID_PX = {GRID_PX};
  var DOOR_INSET_PX = {DOOR_INSET_PX};
  var container = document.getElementById('canvas-container');
  var footprintPath = document.getElementById('footprint-shape');
  var doorArrowsGroup = document.getElementById('door-arrows-group');
  var boxes = Array.prototype.slice.call(document.querySelectorAll('.draggable'));
  var active = null, offsetX = 0, offsetY = 0;
  var activeResize = null;
  var activeRotate = null;

  // The buildable envelope in canvas px — the setback line. Every box is
  // kept inside this rectangle; see the module docstring for why this is
  // a hard constraint rather than a suggestion.
  var ENV = {{
    left: parseFloat(container.dataset.envLeft),
    top: parseFloat(container.dataset.envTop),
    right: parseFloat(container.dataset.envRight),
    bottom: parseFloat(container.dataset.envBottom)
  }};

  function point(e) {{
    if (e.touches && e.touches.length) {{ return {{x: e.touches[0].clientX, y: e.touches[0].clientY}}; }}
    return {{x: e.clientX, y: e.clientY}};
  }}

  // The box's own true (unrotated) rect — its actual plan dimensions,
  // exactly what gets rendered before the CSS rotate transform is applied.
  function rectOf(el) {{
    return {{
      left: parseFloat(el.style.left),
      top: parseFloat(el.style.top),
      width: el.offsetWidth,
      height: el.offsetHeight
    }};
  }}

  function rotationOf(el) {{ return parseFloat(el.dataset.rotation || '0'); }}

  // The rect collision/footprint math should actually use: for an
  // unrotated box this is identical to rectOf. For a rotated one, it's
  // the axis-aligned bounding box of the rotated shape, centered on the
  // same point — bigger than the box's true footprint by design, which is
  // exactly what makes rotating a room visibly push its neighbors and
  // grow the building footprint outline instead of silently doing nothing.
  function effectiveRectOf(el) {{
    var r = rectOf(el);
    var deg = rotationOf(el);
    if (!deg) return r;
    var rad = deg * Math.PI / 180;
    var cosA = Math.abs(Math.cos(rad)), sinA = Math.abs(Math.sin(rad));
    var bboxW = r.width * cosA + r.height * sinA;
    var bboxH = r.width * sinA + r.height * cosA;
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    return {{left: cx - bboxW / 2, top: cy - bboxH / 2, width: bboxW, height: bboxH}};
  }}

  function minOf(el) {{
    return {{w: parseFloat(el.dataset.minWidth), h: parseFloat(el.dataset.minHeight)}};
  }}

  function clamp(v, lo, hi) {{ return Math.max(lo, Math.min(v, hi)); }}

  function snapToGrid(v) {{ return Math.round(v / GRID_PX) * GRID_PX; }}

  // Boxes the owner has deleted are hidden, not removed — they're skipped
  // by collision resolution, the footprint outline, and door arrows, but
  // stay in `boxes` (and keep their data-initial-* attributes) so Reset
  // can always bring them back.
  function activeBoxes() {{
    return boxes.filter(function(b) {{ return b.dataset.deleted !== '1'; }});
  }}

  // Translate-only envelope clamp, using the box's *effective* (rotation-
  // aware) rect to decide how far it's over the line, but writing the
  // shift to its true left/top — a shift moves the AABB and the true rect
  // by exactly the same amount, since the AABB is centered on the box's
  // own center. Used for rotated boxes (shrinking a rotated box's true
  // rectangle would distort it) and as the pinned box's own last-resort
  // clamp (a pinned box is never resized, only ever repositioned).
  function clampPositionOnly(el) {{
    var r = rectOf(el), eff = effectiveRectOf(el);
    var dLeft = 0, dTop = 0;
    if (eff.left < ENV.left) {{ dLeft = ENV.left - eff.left; }}
    else if (eff.left + eff.width > ENV.right) {{ dLeft = ENV.right - (eff.left + eff.width); }}
    if (eff.top < ENV.top) {{ dTop = ENV.top - eff.top; }}
    else if (eff.top + eff.height > ENV.bottom) {{ dTop = ENV.bottom - (eff.top + eff.height); }}
    if (dLeft) {{ el.style.left = (r.left + dLeft) + 'px'; }}
    if (dTop) {{ el.style.top = (r.top + dTop) + 'px'; }}
  }}

  // Keeps a box fully inside the buildable envelope. An unrotated box
  // shrinks toward its own minimum first (never past it), only
  // translating as a last resort — same as before. A rotated box is only
  // ever translated (see clampPositionOnly): resizing its true rectangle
  // while a CSS rotation is applied would visibly distort it, which is a
  // worse outcome than just sliding it to stay inside the line.
  function clampToEnvelope(el) {{
    if (rotationOf(el)) {{ clampPositionOnly(el); return; }}

    var r = rectOf(el), m = minOf(el);
    var left = r.left, top = r.top, width = r.width, height = r.height;

    if (left < ENV.left) {{
      width = Math.max(m.w, width - (ENV.left - left));
      left = ENV.left;
    }}
    if (left + width > ENV.right) {{
      width = Math.max(m.w, width - (left + width - ENV.right));
    }}
    if (left + width > ENV.right) {{
      left = Math.max(ENV.left, ENV.right - width);
    }}

    if (top < ENV.top) {{
      height = Math.max(m.h, height - (ENV.top - top));
      top = ENV.top;
    }}
    if (top + height > ENV.bottom) {{
      height = Math.max(m.h, height - (top + height - ENV.bottom));
    }}
    if (top + height > ENV.bottom) {{
      top = Math.max(ENV.top, ENV.bottom - height);
    }}

    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.width = width + 'px';
    el.style.height = height + 'px';
  }}

  function overlapAmount(a, b) {{
    var ax2 = a.left + a.width, ay2 = a.top + a.height;
    var bx2 = b.left + b.width, by2 = b.top + b.height;
    var ox = Math.min(ax2, bx2) - Math.max(a.left, b.left);
    var oy = Math.min(ay2, by2) - Math.max(a.top, b.top);
    if (ox <= 0 || oy <= 0) {{ return null; }}
    return {{x: ox, y: oy}};
  }}

  // Phase 1 of overlap resolution: every non-pinned box shrinks toward
  // its own minimum size and/or is pushed out of the way of whatever it
  // overlaps (using each box's *effective* rect, so a rotated neighbor's
  // larger swept footprint is respected too), cascading through further
  // overlaps across passes. A rotated box is only ever translated here —
  // never resized — for the same reason clampToEnvelope treats it
  // specially. Returns whether anything changed.
  function shrinkAndPushNonPinned(pinned) {{
    var live = activeBoxes();
    var changedAtAll = false;
    for (var pass = 0; pass < 6; pass++) {{
      var any = false;
      for (var i = 0; i < live.length; i++) {{
        var a = live[i];
        if (a === pinned) continue;
        var ma = minOf(a);
        var aRotated = !!rotationOf(a);
        for (var j = 0; j < live.length; j++) {{
          if (i === j) continue;
          var b = live[j];
          var ra = effectiveRectOf(a), rb = effectiveRectOf(b);
          var ov = overlapAmount(ra, rb);
          if (!ov) continue;
          any = true;
          if (ov.x < ov.y) {{
            var dir = (ra.left + ra.width / 2) < (rb.left + rb.width / 2) ? -1 : 1;
            if (aRotated) {{
              a.style.left = (parseFloat(a.style.left) + dir * ov.x) + 'px';
            }} else {{
              var newWidth = Math.max(ma.w, ra.width - ov.x);
              var consumed = ra.width - newWidth;
              var remaining = ov.x - consumed;
              if (dir === -1) {{
                a.style.width = newWidth + 'px';
                if (remaining > 0) {{ a.style.left = (ra.left - remaining) + 'px'; }}
              }} else {{
                a.style.left = (ra.left + consumed) + 'px';
                a.style.width = newWidth + 'px';
                if (remaining > 0) {{ a.style.left = (parseFloat(a.style.left) + remaining) + 'px'; }}
              }}
            }}
          }} else {{
            var dirY = (ra.top + ra.height / 2) < (rb.top + rb.height / 2) ? -1 : 1;
            if (aRotated) {{
              a.style.top = (parseFloat(a.style.top) + dirY * ov.y) + 'px';
            }} else {{
              var newHeight = Math.max(ma.h, ra.height - ov.y);
              var consumedY = ra.height - newHeight;
              var remainingY = ov.y - consumedY;
              if (dirY === -1) {{
                a.style.height = newHeight + 'px';
                if (remainingY > 0) {{ a.style.top = (ra.top - remainingY) + 'px'; }}
              }} else {{
                a.style.top = (ra.top + consumedY) + 'px';
                a.style.height = newHeight + 'px';
                if (remainingY > 0) {{ a.style.top = (parseFloat(a.style.top) + remainingY) + 'px'; }}
              }}
            }}
          }}
          clampToEnvelope(a);
        }}
      }}
      if (any) {{ changedAtAll = true; }}
      if (!any) break;
    }}
    return changedAtAll;
  }}

  // Phase 2, the overlap invariant's real guarantee: after phase 1, check
  // whether the pinned box — never touched by phase 1 — still overlaps
  // anything. It can, if a neighbor was already at its own minimum size
  // and the envelope wall and genuinely had nowhere left to go. Rather
  // than accept that as a visible glitch, nudge the pinned box itself
  // (position only, its size is never touched) just enough to clear it.
  function pushPinnedClearOfOverlaps(pinned) {{
    if (!pinned) return false;
    var live = activeBoxes();
    var changed = false;
    for (var k = 0; k < live.length; k++) {{
      var other = live[k];
      if (other === pinned) continue;
      var pr = effectiveRectOf(pinned), ro = effectiveRectOf(other);
      var ov = overlapAmount(pr, ro);
      if (!ov) continue;
      changed = true;
      if (ov.x < ov.y) {{
        var dir = (pr.left + pr.width / 2) < (ro.left + ro.width / 2) ? -1 : 1;
        pinned.style.left = (parseFloat(pinned.style.left) + dir * ov.x) + 'px';
      }} else {{
        var dirY = (pr.top + pr.height / 2) < (ro.top + ro.height / 2) ? -1 : 1;
        pinned.style.top = (parseFloat(pinned.style.top) + dirY * ov.y) + 'px';
      }}
      clampPositionOnly(pinned);
    }}
    return changed;
  }}

  // Absolute last resort, tried only once phases 1 and 2 give up: split
  // whatever overlap is still left between BOTH boxes directly, half the
  // separation to each, along whichever axis needs less movement. In a
  // scene crowded enough (several rooms squeezed toward the same small
  // area), the gentler one-box-at-a-time heuristic above can genuinely
  // fail to converge — each box's individual fix can undo a different
  // box's fix, cycling instead of settling. Moving both sides of a
  // conflict at once instead of just one breaks that cycle. This ignores
  // the pinned exemption on purpose: by the time this runs, "no overlap"
  // matters more than "the box under the cursor never moves."
  function forceSeparateAnyRemainingOverlaps() {{
    var live = activeBoxes();
    var changed = false;
    for (var i = 0; i < live.length; i++) {{
      for (var j = i + 1; j < live.length; j++) {{
        var a = live[i], b = live[j];
        var ra = effectiveRectOf(a), rb = effectiveRectOf(b);
        var ov = overlapAmount(ra, rb);
        if (!ov) continue;
        changed = true;
        if (ov.x < ov.y) {{
          // dir=1 means a's center is to the right of b's -- a moves
          // further right (+= ) to separate, b moves further left (-= ).
          var dir = (ra.left + ra.width / 2) < (rb.left + rb.width / 2) ? -1 : 1;
          a.style.left = (parseFloat(a.style.left) + dir * ov.x / 2) + 'px';
          b.style.left = (parseFloat(b.style.left) - dir * ov.x / 2) + 'px';
        }} else {{
          var dirY = (ra.top + ra.height / 2) < (rb.top + rb.height / 2) ? -1 : 1;
          a.style.top = (parseFloat(a.style.top) + dirY * ov.y / 2) + 'px';
          b.style.top = (parseFloat(b.style.top) - dirY * ov.y / 2) + 'px';
        }}
        clampToEnvelope(a);
        clampToEnvelope(b);
      }}
    }}
    return changed;
  }}

  // The full overlap-resolution pass: every round runs all three
  // strategies together — phase 1 (push/shrink everything else), phase 2
  // (nudge the pinned box itself as a last resort), and the unconditional
  // both-sides separator — rather than exhausting phases 1-2 first and
  // only falling back to the separator once. In a dense, heavily-crowded
  // scene (several rooms all pushed toward the same small area) fixing
  // one pair can reopen another; running every strategy every round, over
  // a generous budget, gives the whole arrangement many chances to reach
  // mutual consistency instead of just one. This is what makes "no
  // overlaps" an invariant rather than a best effort.
  function resolveOverlaps(pinned) {{
    for (var outer = 0; outer < 8; outer++) {{
      var changed1 = shrinkAndPushNonPinned(pinned);
      var changed2 = pushPinnedClearOfOverlaps(pinned);
      var changed3 = forceSeparateAnyRemainingOverlaps();
      if (!changed1 && !changed2 && !changed3) break;
    }}
  }}

  // Traces the outline of the union of every current (non-deleted) box's
  // *effective* rect — rooms + corridors, rotated ones included via their
  // swept bounding box — the building's own footprint, recomputed from
  // wherever things actually are right now rather than the initial
  // layout. Works by rasterizing onto the grid formed by every box edge
  // (coordinate compression keeps this small — a handful of rooms means a
  // few dozen cells, not a full-resolution raster) and walking the
  // boundary between covered/uncovered cells into one or more closed
  // loops. Each cell contributes only the edges facing an uncovered
  // neighbor, always in the same rotational direction, so loops close up
  // on their own without needing any special-casing for T-junctions or
  // multiple disjoint shapes (evenodd fill handles the rest, including
  // any hole).
  function computeFootprintPath() {{
    var rects = activeBoxes().map(effectiveRectOf);
    if (!rects.length) return '';

    var xsSet = {{}}, ysSet = {{}};
    rects.forEach(function(r) {{
      xsSet[r.left] = true; xsSet[r.left + r.width] = true;
      ysSet[r.top] = true; ysSet[r.top + r.height] = true;
    }});
    var xs = Object.keys(xsSet).map(Number).sort(function(a, b) {{ return a - b; }});
    var ys = Object.keys(ysSet).map(Number).sort(function(a, b) {{ return a - b; }});
    var nx = xs.length - 1, ny = ys.length - 1;
    if (nx <= 0 || ny <= 0) return '';

    var covered = [];
    for (var i = 0; i < nx; i++) {{
      covered.push([]);
      var cx = (xs[i] + xs[i + 1]) / 2;
      for (var j = 0; j < ny; j++) {{
        var cy = (ys[j] + ys[j + 1]) / 2;
        var hit = false;
        for (var k = 0; k < rects.length; k++) {{
          var r = rects[k];
          if (cx > r.left && cx < r.left + r.width && cy > r.top && cy < r.top + r.height) {{ hit = true; break; }}
        }}
        covered[i][j] = hit;
      }}
    }}

    function isCovered(i, j) {{ return i >= 0 && i < nx && j >= 0 && j < ny && covered[i][j]; }}

    var segs = [];
    for (var i2 = 0; i2 < nx; i2++) {{
      for (var j2 = 0; j2 < ny; j2++) {{
        if (!covered[i2][j2]) continue;
        if (!isCovered(i2 - 1, j2)) segs.push([[xs[i2], ys[j2]], [xs[i2], ys[j2 + 1]]]);
        if (!isCovered(i2 + 1, j2)) segs.push([[xs[i2 + 1], ys[j2 + 1]], [xs[i2 + 1], ys[j2]]]);
        if (!isCovered(i2, j2 - 1)) segs.push([[xs[i2], ys[j2]], [xs[i2 + 1], ys[j2]]]);
        if (!isCovered(i2, j2 + 1)) segs.push([[xs[i2 + 1], ys[j2 + 1]], [xs[i2], ys[j2 + 1]]]);
      }}
    }}
    if (!segs.length) return '';

    var byStart = {{}};
    segs.forEach(function(s, idx) {{
      var key = s[0][0] + ',' + s[0][1];
      byStart[key] = byStart[key] || [];
      byStart[key].push(idx);
    }});

    var used = new Array(segs.length).fill(false);
    var d = '';
    for (var start = 0; start < segs.length; start++) {{
      if (used[start]) continue;
      var loopStart = segs[start][0];
      var loop = [loopStart];
      used[start] = true;
      var next = segs[start][1];
      var guard = 0;
      while ((next[0] !== loopStart[0] || next[1] !== loopStart[1]) && guard < segs.length + 5) {{
        var key2 = next[0] + ',' + next[1];
        var candidates = byStart[key2] || [];
        var found = -1;
        for (var c = 0; c < candidates.length; c++) {{
          if (!used[candidates[c]]) {{ found = candidates[c]; break; }}
        }}
        if (found === -1) break;
        used[found] = true;
        loop.push(next);
        next = segs[found][1];
        guard++;
      }}
      loop.push(next);
      d += 'M ' + loop.map(function(p) {{ return p[0].toFixed(1) + ',' + p[1].toFixed(1); }}).join(' L ') + ' Z ';
    }}
    return d;
  }}

  function updateFootprint() {{
    if (!footprintPath) return;
    var d = computeFootprintPath();
    footprintPath.setAttribute('d', d);
  }}

  // If two rects share a boundary segment, returns {{axis, mid}} — axis
  // 'x' when the shared edge is vertical (side by side, so the door arrow
  // should run horizontally), 'y' when horizontal (stacked, arrow runs
  // vertically). Same algorithm as src/layout.py's _touching_edge, ported
  // to JS so door arrows can be re-walked after every move instead of
  // staying fixed to the initial layout.
  function touchingEdge(a, b, tol) {{
    var ax0 = a.left, ay0 = a.top, ax1 = a.left + a.width, ay1 = a.top + a.height;
    var bx0 = b.left, by0 = b.top, bx1 = b.left + b.width, by1 = b.top + b.height;

    if (Math.abs(ax1 - bx0) < tol || Math.abs(bx1 - ax0) < tol) {{
      var yLo = Math.max(ay0, by0), yHi = Math.min(ay1, by1);
      if (yHi - yLo > tol) {{
        var sharedX = Math.abs(ax1 - bx0) < tol ? bx0 : ax0;
        return {{axis: 'x', mid: [sharedX, (yLo + yHi) / 2]}};
      }}
    }}
    if (Math.abs(ay1 - by0) < tol || Math.abs(by1 - ay0) < tol) {{
      var xLo = Math.max(ax0, bx0), xHi = Math.min(ax1, bx1);
      if (xHi - xLo > tol) {{
        var sharedY = Math.abs(ay1 - by0) < tol ? by0 : ay0;
        return {{axis: 'y', mid: [(xLo + xHi) / 2, sharedY]}};
      }}
    }}
    return null;
  }}

  function perpendicularArrow(axis, mid, fromCenter, toCenter) {{
    var mx = mid[0], my = mid[1];
    if (axis === 'x') {{
      var fromSign = fromCenter[0] < mx ? -1 : 1;
      return [[mx + fromSign * DOOR_INSET_PX, my], [mx - fromSign * DOOR_INSET_PX, my]];
    }}
    var fromSignY = fromCenter[1] < my ? -1 : 1;
    return [[mx, my + fromSignY * DOOR_INSET_PX], [mx, my - fromSignY * DOOR_INSET_PX]];
  }}

  // Breadth-first walk of the touching-graph starting from the entry room
  // — the live equivalent of src/layout.py's _build_circulation_edges.
  // Uses each box's *true* rect (not the rotation-inflated effective
  // one): a door is a literal wall opening, so a merely-rotated room
  // shouldn't register as "touching" a neighbor it doesn't actually share
  // a wall with.
  function computeDoorArrowSegments() {{
    var live = activeBoxes();
    var entryIndex = -1;
    for (var i = 0; i < live.length; i++) {{
      if (live[i].classList.contains('entry')) {{ entryIndex = i; break; }}
    }}
    if (entryIndex === -1) return [];

    var rects = live.map(rectOf);
    var centers = rects.map(function(r) {{ return [r.left + r.width / 2, r.top + r.height / 2]; }});
    var visited = new Array(live.length).fill(false);
    visited[entryIndex] = true;
    var queue = [entryIndex];
    var segs = [];

    while (queue.length) {{
      var cur = queue.shift();
      for (var j = 0; j < live.length; j++) {{
        if (visited[j]) continue;
        var touch = touchingEdge(rects[cur], rects[j], 1.0);
        if (!touch) continue;
        visited[j] = true;
        segs.push(perpendicularArrow(touch.axis, touch.mid, centers[cur], centers[j]));
        queue.push(j);
      }}
    }}
    return segs;
  }}

  function updateDoorArrows() {{
    if (!doorArrowsGroup) return;
    while (doorArrowsGroup.firstChild) {{ doorArrowsGroup.removeChild(doorArrowsGroup.firstChild); }}
    var svgNS = 'http://www.w3.org/2000/svg';
    computeDoorArrowSegments().forEach(function(seg) {{
      var line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', seg[0][0].toFixed(1));
      line.setAttribute('y1', seg[0][1].toFixed(1));
      line.setAttribute('x2', seg[1][0].toFixed(1));
      line.setAttribute('y2', seg[1][1].toFixed(1));
      line.setAttribute('stroke', '#1a1a1a');
      line.setAttribute('stroke-width', '1.6');
      line.setAttribute('stroke-opacity', '0.55');
      line.setAttribute('marker-end', 'url(#door-arrow)');
      doorArrowsGroup.appendChild(line);
    }});
  }}

  // Everything that must be re-derived from scratch after any move,
  // resize, rotate, or delete — never left stale from the initial layout.
  function refreshDiagram() {{
    updateFootprint();
    updateDoorArrows();
  }}

  function onDown(e) {{
    active = e.currentTarget;
    var p = point(e);
    var rect = active.getBoundingClientRect();
    offsetX = p.x - rect.left;
    offsetY = p.y - rect.top;
    active.classList.add('dragging');
    e.preventDefault();
  }}

  function onMove(e) {{
    if (activeResize) {{ doResize(e); return; }}
    if (activeRotate) {{ doRotate(e); return; }}
    if (!active) return;
    var p = point(e);
    var cRect = container.getBoundingClientRect();
    var newLeft = p.x - cRect.left - offsetX;
    var newTop = p.y - cRect.top - offsetY;
    newLeft = clamp(newLeft, ENV.left, ENV.right - active.offsetWidth);
    newTop = clamp(newTop, ENV.top, ENV.bottom - active.offsetHeight);
    newLeft = snapToGrid(newLeft);
    newTop = snapToGrid(newTop);
    active.style.left = newLeft + 'px';
    active.style.top = newTop + 'px';
    clampPositionOnly(active);
    resolveOverlaps(active);
    refreshDiagram();
    e.preventDefault();
  }}

  // Drags a corner handle: the opposite corner stays put, the dragged
  // corner's edges snap to the grid and are clamped to the box's own
  // minimum size, then the envelope constraint and collision resolution
  // apply exactly as they do for a plain move.
  function doResize(e) {{
    var r = activeResize;
    var p = point(e);
    var dx = p.x - r.startPoint.x, dy = p.y - r.startPoint.y;
    var m = minOf(r.el);
    var left = r.start.left, top = r.start.top, width = r.start.width, height = r.start.height;

    if (r.corner === 'ne' || r.corner === 'se') {{
      var right = snapToGrid(r.start.left + r.start.width + dx);
      width = Math.max(m.w, right - left);
    }}
    if (r.corner === 'nw' || r.corner === 'sw') {{
      var newLeft = snapToGrid(r.start.left + dx);
      width = Math.max(m.w, (r.start.left + r.start.width) - newLeft);
      left = (r.start.left + r.start.width) - width;
    }}
    if (r.corner === 'se' || r.corner === 'sw') {{
      var bottom = snapToGrid(r.start.top + r.start.height + dy);
      height = Math.max(m.h, bottom - top);
    }}
    if (r.corner === 'ne' || r.corner === 'nw') {{
      var newTop = snapToGrid(r.start.top + dy);
      height = Math.max(m.h, (r.start.top + r.start.height) - newTop);
      top = (r.start.top + r.start.height) - height;
    }}

    r.el.style.left = left + 'px';
    r.el.style.top = top + 'px';
    r.el.style.width = width + 'px';
    r.el.style.height = height + 'px';
    clampToEnvelope(r.el);
    resolveOverlaps(r.el);
    refreshDiagram();
    e.preventDefault();
  }}

  // Spins a box in fixed 5° steps around its own center, then treats it
  // exactly like a move: clamp to the envelope, push/shrink anything it
  // now overlaps (via its rotation-inflated effective rect), and refresh
  // the footprint/door arrows — see the module docstring for why rotation
  // still visibly affects the rooms around it despite being a pure CSS
  // transform on the box's own true rectangle.
  function doRotate(e) {{
    var p = point(e);
    var rot = activeRotate;
    var angle = Math.atan2(p.y - rot.cy, p.x - rot.cx) * 180 / Math.PI + 90;
    var snapped = Math.round(angle / 5) * 5;
    rot.el.style.transform = 'rotate(' + snapped + 'deg)';
    rot.el.dataset.rotation = String(snapped);
    clampToEnvelope(rot.el);
    resolveOverlaps(rot.el);
    refreshDiagram();
    e.preventDefault();
  }}

  function onResizeDown(e) {{
    e.stopPropagation();
    e.preventDefault();
    var handle = e.currentTarget;
    var box = handle.closest('.draggable');
    activeResize = {{el: box, corner: handle.dataset.corner, start: rectOf(box), startPoint: point(e)}};
    box.classList.add('dragging');
  }}

  function onRotateDown(e) {{
    e.stopPropagation();
    e.preventDefault();
    var box = e.currentTarget.closest('.draggable');
    var r = box.getBoundingClientRect();
    activeRotate = {{el: box, cx: r.left + r.width / 2, cy: r.top + r.height / 2}};
    box.classList.add('dragging');
  }}

  function onDeleteDown(e) {{
    e.stopPropagation();
    e.preventDefault();
    var box = e.currentTarget.closest('.draggable');
    box.dataset.deleted = '1';
    box.classList.add('deleted');
    refreshDiagram();
  }}

  // A gesture in progress only asks resolveOverlaps to protect the one
  // pinned box; every *other* box is free to be shoved by more than one
  // neighbor across a busy scene, and a single call's fixed pass budget
  // can settle one relationship at the cost of re-disturbing another it
  // already fixed earlier in the same call. Once the gesture actually
  // ends, there's no pinned box left to protect and no more urgency —
  // so run one more unrestricted pass (pinned=null, every box eligible)
  // to let the whole arrangement fully settle into mutual consistency,
  // however many relationships that takes.
  function onUp() {{
    if (active) {{ active.classList.remove('dragging'); }}
    if (activeResize) {{ activeResize.el.classList.remove('dragging'); }}
    if (activeRotate) {{ activeRotate.el.classList.remove('dragging'); }}
    var gestureEnded = active || activeResize || activeRotate;
    active = null;
    activeResize = null;
    activeRotate = null;
    if (gestureEnded) {{
      resolveOverlaps(null);
      refreshDiagram();
    }}
  }}

  for (var i = 0; i < boxes.length; i++) {{
    boxes[i].addEventListener('mousedown', onDown);
    boxes[i].addEventListener('touchstart', onDown, {{passive: false}});
  }}
  var resizeHandles = document.querySelectorAll('.resize-handle');
  for (var rh = 0; rh < resizeHandles.length; rh++) {{
    resizeHandles[rh].addEventListener('mousedown', onResizeDown);
    resizeHandles[rh].addEventListener('touchstart', onResizeDown, {{passive: false}});
  }}
  var rotateHandles = document.querySelectorAll('.rotate-handle');
  for (var rt = 0; rt < rotateHandles.length; rt++) {{
    rotateHandles[rt].addEventListener('mousedown', onRotateDown);
    rotateHandles[rt].addEventListener('touchstart', onRotateDown, {{passive: false}});
  }}
  var deleteHandles = document.querySelectorAll('.delete-handle');
  for (var dh = 0; dh < deleteHandles.length; dh++) {{
    deleteHandles[dh].addEventListener('mousedown', onDeleteDown);
    deleteHandles[dh].addEventListener('touchstart', onDeleteDown, {{passive: false}});
  }}

  document.addEventListener('mousemove', onMove);
  document.addEventListener('touchmove', onMove, {{passive: false}});
  document.addEventListener('mouseup', onUp);
  document.addEventListener('touchend', onUp);

  var gridToggle = document.getElementById('grid-toggle');
  var gridOverlay = document.getElementById('grid-overlay');
  if (gridToggle && gridOverlay) {{
    gridToggle.addEventListener('change', function() {{
      gridOverlay.style.display = gridToggle.checked ? 'block' : 'none';
    }});
  }}

  document.getElementById('reset-btn').addEventListener('click', function() {{
    for (var i = 0; i < boxes.length; i++) {{
      boxes[i].style.left = boxes[i].dataset.initialLeft + 'px';
      boxes[i].style.top = boxes[i].dataset.initialTop + 'px';
      boxes[i].style.width = boxes[i].dataset.initialWidth + 'px';
      boxes[i].style.height = boxes[i].dataset.initialHeight + 'px';
      boxes[i].style.transform = '';
      boxes[i].dataset.rotation = '0';
      boxes[i].dataset.deleted = '0';
      boxes[i].classList.remove('deleted');
    }}
    refreshDiagram();
  }});

  refreshDiagram();
}})();
</script>
</body>
</html>
"""

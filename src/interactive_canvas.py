"""Interactive drag canvas: the *only* zoning diagram this tool renders.

It shows Claude's recommended room grouping and layout (src.layout,
src.layout_plan) — title, color-coded legend, and rationale included — as
draggable, resizable, rotatable, deletable boxes the owner can rearrange by
hand to explore a different arrangement, plus a live-synced room schedule
in a panel to its left. Corridors are draggable exactly like rooms
(nothing here is a fixed zone); the site outline, the buildable envelope (setback) outline,
the building footprint, the street marker, and door arrows are the only
static-position backdrop — everything else recomputes live as boxes move.

**Selection.** A box's resize/rotate/delete handles are hidden until it's
selected — clicking its body (or its schedule row) selects it and clears
any other selection; shift-clicking toggles it into/out of a multi-box
selection instead; clicking empty canvas clears the selection entirely.
Resize handles only ever show for a lone selection (resizing several boxes
from one dragged corner is ambiguous); rotate and delete act on the whole
selection when more than one box is selected — see "Multi-select" below.

Per-box controls, all pure client-side JS (see the generated `<script>`):

- **Drag** the body of a box to move it (`onDown`/`onMove`). Dragging
  also snaps the box to touch a same-facing neighbor it ends up within 1m
  of, closing the gap instead of leaving a sliver (`findNearestGapDelta`,
  `GAP_SNAP_PX`) — see "Gap closing" below.
- **Drag a corner handle** to resize it (`onResizeDown`/`doResize`) —
  the opposite corner stays put. Solo-selection only.
- **Drag the rotate handle** to spin it in fixed 5° steps (`onRotateDown`/
  `doRotate`), the same relative amount for every box in the selection at
  once if more than one is selected ("Multi-select" below). Rotation is a
  CSS `transform` for rendering, but overlap detection uses the box's true
  rotated shape (`obbOf`/`obbsSeparated`, oriented-box SAT) — so two
  rotated rooms can actually be pushed together until their real edges
  touch, not stopped early by an inflated bounding-box margin — while the
  *collision-response bookkeeping* (how far to push, whether a shrink is
  possible) still works off the rotated shape's axis-aligned bounding box
  (`effectiveRectOf`) for simplicity, and a rotated box is only ever
  translated, never resized, when it has to give way.
- **Click the delete handle** to remove a box (`onDeleteDown`) — it's
  hidden (not destroyed) so "Reset to recommended layout" can always bring
  it back. Deletes the whole selection if more than one box is selected.
- **The grid checkbox** toggles a faint 0.25m reference grid
  (`#grid-overlay`). Independent of that toggle, every box's position
  always snaps to that same 0.25m grid while dragging or resizing
  (`snapToGrid`, `GRID_PX`) — the grid is a visibility choice, snapping
  isn't.
**Rotation bites, it does not shove.** A rotated box is allowed to overlap
a square neighbor, and the neighbor gives up exactly the overlapping
sliver — it draws itself carved (an L-shape against the slanted wall)
while its rectangle, position and schedule entry stay put. The collision
gate (`boxesReallyOverlap`) reports such a pair as *not* overlapping,
which is what keeps every push, shrink and cascade off them. A bite is
only allowed when the victim keeps its minimum area AND still holds its
minimum rectangle (`canAbsorbBite`) — area alone isn't enough, since an
L-shape can keep its area as a dogleg nothing fits in — and when the cut
leaves one piece with no hole in it, which is also what stops circulation
from ever being severed. Where a bite is refused, the *rotation* is
refused (`rotationIsAllowed`), never the neighbor's position: pushes are
one-way, so one awkward angle part-way through a drag used to shove the
hallway across the plot with nothing to put it back, scattering a whole
plan for a turn the owner didn't even settle on.

**Shape morphing.** A box's *logical* shape is always a plain rectangle
plus a rotation — that is what the schedule's width/depth edit, what
resize changes, and what collision tests. Its *display* shape, painted on
a `.fill` child, may be a polygon, for the carve above and for gap fill:
a square neighbor reaches into the triangular void a rotation opens (up to
`MORPH_REACH_PX`) and stops against the rotated box's wall. A fill is
abandoned if it would take space another box is using
(`growthHitsAnotherBox`, measured as real intersection area), and boxes
are shaped in order against the shapes already settled, so two rooms
either side of one slot cannot both claim it. Everything is recomputed
from the rectangles each frame and never written back, so un-rotating
restores every neighbor whole.

**Boolean geometry.** Carving, gap fill and the footprint outline all go
through the vendored polygon-clipping library (`src/vendor/`, MIT),
inlined into the page so the document stays self-contained with no CDN
dependency. Two hand-rolled generations of this preceded it — a
rectilinear rasterizer, then an edge-splitting union with outward probing
and endpoint welding — and both are where this canvas's outline bugs came
from. An earlier carve clipped against the infinite *line* through the
rotated box's nearest wall rather than its actual footprint, which cut
clean across a neighbor however small the real overlap was, and turned
bathrooms into triangles.

- **The room schedule** in the column left of the canvas lists every
  box's current width and depth in meters, editable in place — typing a
  new value resizes the box on the canvas (`applyScheduleEdit`) exactly
  as if you'd dragged its corner, growing/shrinking from its center since
  a table cell has no natural corner to anchor to. It stays live-synced with the canvas in
  both directions (`renderSchedule`, folded into `refreshDiagram` so it
  updates on every move/resize/rotate/delete/reset) — clicking a row
  selects the matching box and vice versa, and in-place DOM updates (not a
  full rebuild) mean typing in one row's field survives a drag happening
  elsewhere on the canvas at the same time.

**Multi-select.** Shift-click adds/removes a box from the selection
instead of replacing it. With more than one box selected, grabbing *any*
selected box's rotate handle spins the whole selection together — each
box keeps rotating around its own center, by the same angle delta, not a
single shared pivot — and clicking *any* selected box's delete handle (or
a schedule row's) removes the whole selection at once.

**Gap closing.** Beyond plain grid-snapping, dragging a box that ends up
less than 1m from a same-facing neighbor (their ranges overlap on the
other axis — this isn't just "nearby diagonally") snaps it the rest of
the way to touch that neighbor exactly, on each axis independently
(`findNearestGapDelta`). The idea is to make it easy to eliminate an
accidental sliver of empty space between zones without having to
pixel-hunt for the exact touching position.

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
   (`forceSeparateAnyRemainingOverlaps`). All three read `boxesReallyOverlap`
   rather than raw bounding-box overlap, so a merely-close (not actually
   intersecting) pair of rotated boxes is left alone instead of being
   pushed apart early.
2. **The setback line is a hard wall.** Every box is kept inside the
   buildable envelope (`data-env-*` on #canvas-container) — an unrotated
   box shrinks toward its own minimum before crossing it; a rotated box
   (whose true shape isn't axis-aligned) is translated instead, since
   shrinking its underlying rectangle while rotated would distort it.
3. **Rooms may shrink, never below their minimum.** Same minimums as the
   initial packer's own compaction (`src/layout.py`) — `data-min-width`/
   `data-min-height`, from `src/defaults.py` for rooms and the fixed code
   hallway width for corridors. The schedule enforces the same floor on
   its own inputs.

Two things are recomputed from scratch after every move, resize, rotate,
or delete (`refreshDiagram`), never left stale from the initial layout:

- **The building footprint outline** — the live union of every current
  box's true rotated shape (`computeFootprintPath`, via oriented-box
  point containment — a rotated room's contribution follows its actual
  diamond/parallelogram footprint, not an inflated bounding box, even
  though the traced outline itself stays rectilinear).
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
selection, and deleted-state all back to Claude's recommended layout,
stored in each box's own data attributes.
"""

from __future__ import annotations

import html as html_module
from functools import lru_cache
from pathlib import Path
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

# The room-schedule panel sits to the LEFT of the diagram (see
# #canvas-layout). This is its preferred width — wide enough for a typical
# room name plus the width/depth inputs, the rotation readout and the
# delete button. It shrinks toward the minimum on a narrow viewport rather
# than pushing the diagram out of the component's fixed height.
SCHEDULE_WIDTH_PX = 372
SCHEDULE_MIN_WIDTH_PX = 280
# Gap between the schedule panel and the diagram (matches #canvas-layout).
SCHEDULE_GAP_PX = 18

# How far an unrotated box may grow its display shape to reach a rotated
# neighbor's slanted wall — see "Shape morphing" in the module docstring.
# Beyond this the gap is real dead space, not a sliver worth absorbing.
MORPH_REACH_M = 2.0
MORPH_REACH_PX = MORPH_REACH_M * PX_PER_METER

# The most of itself a room may give up to a rotated neighbor biting into
# it before the bite stops counting as "minor" and collision pushes the
# pair apart instead. This is a backstop, not the real guard -- the real
# guards are that the room keeps its minimum area AND still holds its
# minimum rectangle. A tighter fraction reads well for a square room but
# punishes a long thin one: a shallow bite across a 17m hallway is over a
# third of its area while barely touching it, and refusing that puts the
# hallway back to being shoved across the plot.
BITE_MAX_FRACTION = 0.45
# Vertical space the component needs on top of the canvas itself: title +
# legend row above it, and the reset button + rationale below. app.py uses
# this to size the Streamlit component — the schedule no longer adds any
# height of its own now that it sits beside the diagram.
CANVAS_CHROME_HEIGHT_PX = 220

# Every box's position snaps to this grid while dragging or resizing,
# regardless of whether the grid overlay is visible (see #grid-toggle).
GRID_M = 0.25
GRID_PX = GRID_M * PX_PER_METER

# Dragging a box within this distance of a same-facing neighbor snaps it
# the rest of the way to touch — see "Gap closing" in the module docstring.
GAP_SNAP_M = 1.0
GAP_SNAP_PX = GAP_SNAP_M * PX_PER_METER

# How far each door arrow's endpoints sit from the wall it crosses — same
# value src/layout.py's _perpendicular_arrow uses, in meters.
DOOR_INSET_M = 0.35
DOOR_INSET_PX = DOOR_INSET_M * PX_PER_METER

# Corner-resize handles, a rotate handle (5° increments — see the module
# docstring for how rotation still affects neighbors despite being a CSS
# transform), and a delete handle, appended into every room/corridor div.
# All hidden until the box is selected — see the module docstring.
# Static markup, no per-room data.
_HANDLES_HTML = (
    '<span class="resize-handle nw" data-corner="nw"></span>'
    '<span class="resize-handle ne" data-corner="ne"></span>'
    '<span class="resize-handle sw" data-corner="sw"></span>'
    '<span class="resize-handle se" data-corner="se"></span>'
    '<span class="rotate-handle" title="Rotate (5° steps)">&#8635;</span>'
    '<span class="delete-handle" title="Delete">&times;</span>'
)


@lru_cache(maxsize=1)
def _polygon_clipping_js() -> str:
    """The vendored polygon-clipping library (src/vendor/, MIT), inlined
    into the page rather than pulled from a CDN so the diagram stays a
    self-contained document that works offline. It provides the boolean
    polygon operations the canvas needs: subtracting a rotated room from
    the neighbor it bites into, and unioning every room into the building
    footprint outline."""
    return (Path(__file__).parent / "vendor" / "polygon-clipping.umd.min.js").read_text()


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
            f'<span class="fill"></span>'
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
            f'style="left:{left:.1f}px;top:{top:.1f}px;width:{w:.1f}px;height:{h:.1f}px;" '
            f'data-initial-left="{left:.1f}" data-initial-top="{top:.1f}" '
            f'data-initial-width="{w:.1f}" data-initial-height="{h:.1f}" '
            f'data-min-width="{min_w_px:.1f}" data-min-height="{min_h_px:.1f}">'
            f'<span class="fill" style="background:{color};"></span>'
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
  .draggable.selected {{
    outline: 2px solid #2a78d6;
    outline-offset: 2px;
    z-index: 40;
  }}
  /* Everything a box PAINTS lives on this child, never on the box itself.
     The box stays a plain rectangle — that's what the schedule reports,
     what resize edits and what collision tests — while .fill is free to be
     a polygon (clip-path) that reaches past the box's own bounds to meet a
     rotated neighbor's slanted wall. See applyDisplayShapes() in the JS and
     "Shape morphing" in the module docstring. */
  .fill {{
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    pointer-events: none;
    z-index: 0;
  }}
  .corridor > .fill {{
    border: 1px dashed #b9b9b3;
    background-image: repeating-linear-gradient(45deg, #dcdcd6 0, #dcdcd6 4px, #f2f2ee 4px, #f2f2ee 10px);
  }}
  .room-box > .fill {{
    border-radius: 8px;
    border: 1px solid rgba(0,0,0,0.35);
    box-shadow: 0 3px 7px rgba(15,23,42,0.22);
  }}
  /* A morphed box is no longer a rounded rectangle — square the corners
     off so the grown wedge reads as one continuous room edge rather than a
     rectangle with a tab bolted onto it. */
  .room-box.morphed > .fill {{
    border-radius: 0;
    box-shadow: none;
  }}
  .room-box.entry > .fill {{
    border: 2.5px dashed #0b0b0b;
  }}
  .label {{
    position: relative;
    z-index: 1;
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
  /* Resize/rotate/delete handles are hidden and non-interactive until the
     box is selected — see the module docstring's Selection section. */
  .resize-handle, .rotate-handle, .delete-handle {{
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.1s ease;
  }}
  .resize-handle {{
    position: absolute;
    width: 9px;
    height: 9px;
    background: #ffffff;
    border: 1.5px solid #333333;
    border-radius: 2px;
    z-index: 60;
    touch-action: none;
  }}
  .draggable.solo-selected .resize-handle {{ opacity: 0.85; pointer-events: auto; }}
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
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    line-height: 1;
    cursor: grab;
    touch-action: none;
  }}
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
    z-index: 61;
    cursor: pointer;
    touch-action: none;
  }}
  .draggable.selected .rotate-handle,
  .draggable.selected .delete-handle {{
    opacity: 0.85;
    pointer-events: auto;
  }}
  .delete-handle:hover {{ opacity: 1 !important; background: #a5301f; }}
  .rotate-handle:hover {{ opacity: 1 !important; }}
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
  /* The diagram and the schedule sit side by side, schedule on the left,
     so there is exactly one room table in the whole app and it reads as a
     panel beside the drawing rather than a second thing below it.
     Deliberately nowrap: the component's height is fixed by app.py from
     the canvas size, so a wrap would push the diagram down out of view.
     The canvas column is a fixed pixel size (absolutely-positioned boxes
     live in it) and the schedule is the flexible one — on a narrow
     viewport it shrinks toward SCHEDULE_MIN_WIDTH_PX and its table
     scrolls sideways rather than displacing the drawing. */
  #canvas-layout {{
    display: flex;
    flex-wrap: nowrap;
    align-items: flex-start;
    gap: {SCHEDULE_GAP_PX}px;
  }}
  #canvas-column {{
    flex: 0 0 auto;
  }}
  #schedule-section {{
    flex: 1 1 {SCHEDULE_WIDTH_PX}px;
    min-width: {SCHEDULE_MIN_WIDTH_PX}px;
    max-width: {SCHEDULE_WIDTH_PX}px;
  }}
  .schedule-title {{
    font-size: 14px;
    font-weight: 700;
    color: #1a1a1a;
    margin: 0 0 6px 4px;
  }}
  .schedule-hint {{
    font-size: 11.5px;
    color: #77776f;
    margin: 0 0 6px 4px;
  }}
  /* Tall enough to sit alongside the diagram and scroll internally when a
     program has more rooms than the drawing is tall. overflow-x covers the
     squeezed case described on #schedule-section. */
  #schedule-scroll {{
    max-height: {height_px}px;
    overflow-y: auto;
    overflow-x: auto;
    border: 1px solid #e5e5e0;
    border-radius: 6px;
  }}
  #schedule-table {{
    border-collapse: collapse;
    font-size: 12.5px;
    width: 100%;
    min-width: {SCHEDULE_MIN_WIDTH_PX}px;
  }}
  #schedule-table th, #schedule-table td {{
    border-bottom: 1px solid #e5e5e0;
    padding: 5px 6px;
    text-align: left;
  }}
  /* Keep the name column from starving the size inputs and the delete
     button of width when a room name is long. */
  #schedule-table th:first-child, #schedule-table td:first-child {{
    max-width: 110px;
  }}
  #schedule-table th:last-child, #schedule-table td:last-child {{
    width: 22px;
    padding-left: 0;
    padding-right: 4px;
  }}
  #schedule-table thead th {{
    position: sticky;
    top: 0;
    background: #fbfbf9;
    color: #55554f;
    font-weight: 600;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }}
  #schedule-table tbody tr:hover {{ background: rgba(0,0,0,0.02); }}
  #schedule-table tr.schedule-row-selected {{ background: rgba(42,120,214,0.10); }}
  /* Carved rooms report a live area that no longer matches width x depth,
     so mark it rather than let it read as an arithmetic error. */
  #schedule-table td.schedule-area {{ font-variant-numeric: tabular-nums; }}
  #schedule-table td.area-morphed {{ color: #1b6b4a; font-weight: 600; }}
  #schedule-table input[type="number"] {{
    width: 48px;
    font-size: 12.5px;
    padding: 2px 4px;
    border: 1px solid #ccc;
    border-radius: 3px;
    font-family: {FONT_STACK};
  }}
  .schedule-delete {{
    border: none;
    background: none;
    color: #c0392b;
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
  }}
  .schedule-delete:hover {{ color: #a5301f; }}
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
  <div id="canvas-layout">
    <div id="schedule-section">
      <h3 class="schedule-title">Room Schedule</h3>
      <p class="schedule-hint">Click a row to select it on the diagram. Edit width/depth here or by dragging a corner.</p>
      <div id="schedule-scroll">
        <table id="schedule-table">
          <thead>
            <tr><th>Space</th><th>Width (m)</th><th>Depth (m)</th><th>Area (m&sup2;)</th><th>Rot.</th><th></th></tr>
          </thead>
          <tbody id="schedule-body"></tbody>
        </table>
      </div>
    </div>

    <div id="canvas-column">
      <div id="canvas-container" data-env-left="{env_left:.1f}" data-env-top="{env_top:.1f}" data-env-right="{env_right:.1f}" data-env-bottom="{env_bottom:.1f}">
        {_static_svg(project, envelope, result)}
        {_corridor_divs(project, result)}
        {_room_divs(project, result, assignments)}
      </div>
      <button id="reset-btn" type="button">Reset to recommended layout</button>
      <p class="canvas-rationale">{_esc(layout_plan.rationale)}</p>
    </div>
  </div>

<script>{_polygon_clipping_js()}</script>
<script>
(function() {{
  var polygonClipping = window.polygonClipping;
  var GRID_PX = {GRID_PX};
  var GAP_SNAP_PX = {GAP_SNAP_PX};
  var DOOR_INSET_PX = {DOOR_INSET_PX};
  var PX_PER_METER = {PX_PER_METER};
  var MORPH_REACH_PX = {MORPH_REACH_PX};
  var BITE_MAX_FRACTION = {BITE_MAX_FRACTION};
  var container = document.getElementById('canvas-container');
  var footprintPath = document.getElementById('footprint-shape');
  var doorArrowsGroup = document.getElementById('door-arrows-group');
  var boxes = Array.prototype.slice.call(document.querySelectorAll('.draggable'));
  var active = null, offsetX = 0, offsetY = 0;
  var activeResize = null;
  var activeRotate = null;
  var selected = [];

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
  // Sizes come from the inline style, not offsetWidth/offsetHeight: those
  // round to whole pixels, and against a fractional style.left that leaves
  // two rooms the layout placed flush ~0.2px apart. Collision shrugged that
  // off, but the footprint union stitches boundary segments by matching
  // their endpoints, and a hairline mismatch there splits one clean outline
  // into a fistful of open chains.
  function rectOf(el) {{
    return {{
      left: parseFloat(el.style.left),
      top: parseFloat(el.style.top),
      width: el.style.width ? parseFloat(el.style.width) : el.offsetWidth,
      height: el.style.height ? parseFloat(el.style.height) : el.offsetHeight
    }};
  }}

  function rotationOf(el) {{ return parseFloat(el.dataset.rotation || '0'); }}

  // The rect collision/footprint bookkeeping should actually use: for an
  // unrotated box this is identical to rectOf. For a rotated one, it's
  // the axis-aligned bounding box of the rotated shape, centered on the
  // same point — bigger than the box's true footprint by design, which is
  // exactly what makes rotating a room visibly push its neighbors and
  // grow the building footprint outline instead of silently doing nothing.
  // Whether two boxes actually overlap is decided separately, by
  // boxesReallyOverlap/obbsSeparated, which use the *true* rotated shape —
  // this AABB is only used once a real overlap is already established, to
  // work out how far to push.
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

  // The box's true rotated shape as an oriented box: center, half-extents,
  // and its own two unit axis vectors (rotated by its own angle). Used for
  // exact overlap testing (obbsSeparated, SAT) and, via cornersOfObb, as
  // the starting polygon for the box's display shape and the footprint
  // union — all of which care about the *actual* rotated shape, not its
  // inflated AABB.
  function obbOf(el) {{
    var r = rectOf(el);
    var rad = rotationOf(el) * Math.PI / 180;
    return {{
      cx: r.left + r.width / 2, cy: r.top + r.height / 2,
      hw: r.width / 2, hh: r.height / 2,
      ax: [Math.cos(rad), Math.sin(rad)],
      ay: [-Math.sin(rad), Math.cos(rad)]
    }};
  }}

  function cornersOfObb(obb) {{
    var local = [[-obb.hw, -obb.hh], [obb.hw, -obb.hh], [obb.hw, obb.hh], [-obb.hw, obb.hh]];
    return local.map(function(p) {{
      return [obb.cx + p[0] * obb.ax[0] + p[1] * obb.ay[0], obb.cy + p[0] * obb.ax[1] + p[1] * obb.ay[1]];
    }});
  }}

  // True oriented-box vs oriented-box separation test (separating axis
  // theorem, 4 candidate axes — each box's own local x/y). Returns true
  // only when a genuine gap exists along at least one axis; false means
  // the two rotated shapes actually intersect. This is what lets two
  // rotated rooms be pushed together until their real edges touch,
  // instead of stopping early the way an AABB-only check would (an AABB
  // around a rotated square is bigger than the square itself).
  function obbsSeparated(A, B) {{
    var dx = B.cx - A.cx, dy = B.cy - A.cy;
    var axes = [A.ax, A.ay, B.ax, B.ay];
    for (var i = 0; i < axes.length; i++) {{
      var L = axes[i];
      var dist = Math.abs(dx * L[0] + dy * L[1]);
      var projA = A.hw * Math.abs(A.ax[0] * L[0] + A.ax[1] * L[1]) + A.hh * Math.abs(A.ay[0] * L[0] + A.ay[1] * L[1]);
      var projB = B.hw * Math.abs(B.ax[0] * L[0] + B.ax[1] * L[1]) + B.hh * Math.abs(B.ay[0] * L[0] + B.ay[1] * L[1]);
      if (dist > projA + projB + 0.05) return true;
    }}
    return false;
  }}

  // The real overlap test every collision-resolution function uses. `ov`
  // is the caller's already-computed AABB/effective-rect overlap (cheap,
  // and still needed for push direction/magnitude) — when neither box is
  // rotated, AABB and true shape agree exactly, so this is free. When
  // either is rotated, the AABBs can overlap while the true rotated
  // shapes don't (two diamonds near each other, say) — SAT decides which
  // is actually true.
  function boxesTrulyIntersect(a, b) {{
    if (!rotationOf(a) && !rotationOf(b)) {{
      return rectsOverlap(effectiveRectOf(a), effectiveRectOf(b));
    }}
    return !obbsSeparated(obbOf(a), obbOf(b));
  }}

  function rectsOverlap(a, b) {{
    return a.left < b.left + b.width && b.left < a.left + a.width &&
           a.top < b.top + b.height && b.top < a.top + a.height;
  }}

  function boxesReallyOverlap(a, b, ov) {{
    if (!ov) return false;
    if (!boxesTrulyIntersect(a, b)) return false;
    // A rotated room is allowed to bite into a square neighbor rather than
    // shove it away, PROVIDED the neighbor can give up the overlapping
    // sliver and still be a usable room (canAbsorbBite). Reporting the pair
    // as not-overlapping is what keeps every push, shrink and cascade off
    // them -- the neighbor simply draws itself carved instead. Rotation
    // stays a local edit this way, rather than scattering the whole plan.
    if (canAbsorbBite(a, b) || canAbsorbBite(b, a)) return false;
    return true;
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
  // *actually* overlaps (boxesReallyOverlap — true rotated shapes, not
  // just AABBs; using each box's *effective* rect for the push magnitude
  // once a real overlap is confirmed, so a rotated neighbor's larger
  // swept footprint is respected), cascading through further overlaps
  // across passes. A rotated box is only ever translated here — never
  // resized — for the same reason clampToEnvelope treats it specially.
  // Returns whether anything changed.
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
          if (!boxesReallyOverlap(a, b, ov)) continue;
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
      if (!boxesReallyOverlap(pinned, other, ov)) continue;
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

  // Absolute last resort, tried alongside phases 1 and 2 every round:
  // split whatever overlap is still left between BOTH boxes directly,
  // half the separation to each, along whichever axis needs less
  // movement. In a scene crowded enough (several rooms squeezed toward
  // the same small area), the gentler one-box-at-a-time heuristic above
  // can genuinely fail to converge — each box's individual fix can undo a
  // different box's fix, cycling instead of settling. Moving both sides
  // of a conflict at once instead of just one breaks that cycle. This
  // ignores the pinned exemption on purpose: by the time this runs, "no
  // overlap" matters more than "the box under the cursor never moves."
  function forceSeparateAnyRemainingOverlaps() {{
    var live = activeBoxes();
    var changed = false;
    for (var i = 0; i < live.length; i++) {{
      for (var j = i + 1; j < live.length; j++) {{
        var a = live[i], b = live[j];
        var ra = effectiveRectOf(a), rb = effectiveRectOf(b);
        var ov = overlapAmount(ra, rb);
        if (!boxesReallyOverlap(a, b, ov)) continue;
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

  // ---- Boolean geometry -------------------------------------------------
  //
  // All of it goes through the vendored polygon-clipping library. Rings are
  // plain [x, y] arrays; the library takes/returns GeoJSON-ish nesting:
  // a Polygon is [outerRing, ...holes] and a MultiPolygon is [Polygon, ...].
  // Its rings are explicitly closed (last point repeats the first), which
  // the ringToPoly helper strips back off.
  function polyToGeom(poly) {{ return [poly.map(function(p) {{ return [p[0], p[1]]; }})]; }}

  function ringToPoly(ring) {{
    var out = ring.map(function(p) {{ return [p[0], p[1]]; }});
    if (out.length > 1) {{
      var a = out[0], b = out[out.length - 1];
      if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) out.pop();
    }}
    return out;
  }}

  function polyArea(poly) {{
    var a = 0;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {{
      a += (poly[j][0] * poly[i][1]) - (poly[i][0] * poly[j][1]);
    }}
    return Math.abs(a) / 2;
  }}

  // Subtract `clippers` from `subject`. Returns null when the result is
  // anything a single CSS clip-path polygon can't draw -- more than one
  // piece, or a piece with a hole in it. Callers treat null as "this cut
  // isn't allowed", which is also what keeps a room from being sliced in
  // two or turned into a doughnut.
  function subtractPolys(subject, clippers) {{
    if (!clippers.length) return subject;
    var args = [polyToGeom(subject)].concat(clippers.map(polyToGeom));
    var out;
    try {{ out = polygonClipping.difference.apply(polygonClipping, args); }}
    catch (err) {{ return null; }}
    if (!out || out.length !== 1) return null;
    if (out[0].length !== 1) return null;
    var ring = ringToPoly(out[0][0]);
    return ring.length >= 3 ? ring : null;
  }}

  function unionPolys(polys) {{
    if (!polys.length) return [];
    var geoms = polys.map(polyToGeom);
    try {{
      return polygonClipping.union.apply(polygonClipping, geoms);
    }} catch (err) {{
      return geoms;
    }}
  }}

  // ---- Display shapes ---------------------------------------------------
  //
  // A box's LOGICAL shape is always a rectangle plus a rotation: that's what
  // the schedule's width/depth edit, what resize changes, and what the
  // packer produced. Its DISPLAY shape, painted on the .fill child, may be
  // a polygon, for two reasons -- both of them things a rotated room does to
  // the square rooms around it:
  //
  //   CARVE. A rotated room is allowed to bite into a neighbor rather than
  //   shoving it away (see canAbsorbBite). The neighbor gives up exactly the
  //   overlapping sliver and keeps the rest, so it reads as an L-shaped room
  //   against a slanted wall. Subtracting the rotated room's real footprint
  //   is the whole point: an earlier version clipped against the infinite
  //   LINE through the rotated room's nearest wall, which cut clean across
  //   the neighbor however small the actual overlap was, and turned
  //   bathrooms into triangles.
  //
  //   GAP FILL. Rotating also opens triangular voids. A square neighbor
  //   reaches into that void (up to MORPH_REACH_PX) and stops against the
  //   rotated room's wall, so the space becomes floor instead of a slot you
  //   can't walk through.
  //
  // Both are recomputed from the rectangles on every frame and never written
  // back into them, so un-rotating a room restores its neighbors whole.
  var displayPolys = [];

  function polyOfBox(el) {{ return cornersOfObb(obbOf(el)); }}

  function rectPolyOf(r) {{
    return [[r.left, r.top], [r.left + r.width, r.top],
            [r.left + r.width, r.top + r.height], [r.left, r.top + r.height]];
  }}

  function pointInPoly(px, py, poly) {{
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {{
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }}
    return inside;
  }}

  function bboxOf(poly) {{
    var b = {{minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity}};
    for (var i = 0; i < poly.length; i++) {{
      b.minX = Math.min(b.minX, poly[i][0]); b.maxX = Math.max(b.maxX, poly[i][0]);
      b.minY = Math.min(b.minY, poly[i][1]); b.maxY = Math.max(b.maxY, poly[i][1]);
    }}
    return b;
  }}

  // The largest axis-aligned rectangle still guaranteed to fit in `rect`
  // once `bite` has been taken out of it. Measured as the best of the four
  // full-height/full-width strips left either side of the bite, which is a
  // LOWER bound -- it can undercount an L-shape's true best rectangle, never
  // overcount it. Erring that way means a carve is occasionally refused that
  // would have been fine, and never allowed when it wouldn't.
  function largestFreeStrip(rect, bite) {{
    var r = {{x0: rect.left, y0: rect.top, x1: rect.left + rect.width, y1: rect.top + rect.height}};
    var strips = [
      {{w: Math.max(0, bite.minX - r.x0), h: rect.height}},
      {{w: Math.max(0, r.x1 - bite.maxX), h: rect.height}},
      {{w: rect.width, h: Math.max(0, bite.minY - r.y0)}},
      {{w: rect.width, h: Math.max(0, r.y1 - bite.maxY)}}
    ];
    return strips;
  }}

  // Can `victim` give up the part of it `biter` overlaps, instead of being
  // shoved out of the way? Three things all have to hold, and this same
  // computation is what actually draws the carved shape later.
  //
  //   1. The bite is minor: no more than BITE_MAX_FRACTION of the room.
  //      This is also what stops a rotated room being dragged clear inside
  //      a big one, which would need a hole in it to draw.
  //   2. What's left is at least the room's minimum AREA.
  //   3. What's left still holds the room's minimum RECTANGLE. Area alone
  //      isn't enough -- an L-shape can keep its area as a dogleg too narrow
  //      for anything to fit in.
  //
  // Corridors are carved on the same terms as rooms. A hallway can lose a
  // corner and still be a hallway; what it can't survive is being cut in
  // two, and subtractPolys already refuses any cut that splits a shape --
  // so circulation can never be severed by a bite. Its minimum on both axes
  // is the code hallway width, so the minimum-rectangle test below keeps
  // the remaining strip at full width.
  function canAbsorbBite(victim, biter) {{
    if (rotationOf(victim)) return false;
    if (!rotationOf(biter)) return false;

    var rect = rectOf(victim);
    var base = rectPolyOf(rect);
    var cut = subtractPolys(base, [polyOfBox(biter)]);
    if (!cut) return false;

    var full = rect.width * rect.height;
    var left = polyArea(cut);
    if (full <= 0) return false;
    if ((full - left) / full > BITE_MAX_FRACTION) return false;

    var min = minOf(victim);
    if (left < min.w * min.h - 1e-6) return false;

    var bite = bboxOf(polyOfBox(biter));
    var strips = largestFreeStrip(rect, bite);
    for (var i = 0; i < strips.length; i++) {{
      if (strips[i].w >= min.w - 1e-6 && strips[i].h >= min.h - 1e-6) return true;
    }}
    return false;
  }}

  // Every rotated box currently biting into `el`, i.e. overlapping it by an
  // amount `el` is able to give up.
  function bitersOf(el, live) {{
    var out = [];
    for (var i = 0; i < live.length; i++) {{
      var o = live[i];
      if (o === el || !rotationOf(o)) continue;
      if (!rectsOverlap(effectiveRectOf(el), effectiveRectOf(o))) continue;
      if (!boxesTrulyIntersect(el, o)) continue;
      if (canAbsorbBite(el, o)) out.push(o);
    }}
    return out;
  }}

  // Grow `r` on the one side facing (ocx, ocy) by `reach` px.
  function grownRectToward(r, ocx, ocy, reach) {{
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var dx = ocx - cx, dy = ocy - cy;
    var g = {{left: r.left, top: r.top, width: r.width, height: r.height}};
    if (Math.abs(dx) > Math.abs(dy)) {{
      if (dx > 0) {{ g.width += reach; }} else {{ g.left -= reach; g.width += reach; }}
    }} else {{
      if (dy > 0) {{ g.height += reach; }} else {{ g.top -= reach; g.height += reach; }}
    }}
    return g;
  }}

  function morphedPolygonFor(el, live, settled) {{
    var r = rectOf(el);
    if (rotationOf(el)) return polyOfBox(el);

    var poly = rectPolyOf(r);
    var rotated = [];
    for (var i = 0; i < live.length; i++) {{
      var o = live[i];
      if (o !== el && rotationOf(o)) rotated.push(o);
    }}
    if (!rotated.length) return poly;

    // Gap fill first, so the reach is measured from the room's real
    // rectangle; the carve below then trims whatever the rotated rooms
    // actually occupy, out of the grown shape and the original alike.
    for (var g = 0; g < rotated.length; g++) {{
      var o2 = rotated[g], obb = obbOf(o2);
      var oPoly = polyOfBox(o2);
      if (distanceBetweenPolys(poly, oPoly) > MORPH_REACH_PX) continue;
      var grown = rectPolyOf(grownRectToward(r, obb.cx, obb.cy, MORPH_REACH_PX));
      var merged = unionPolys([poly, grown]);
      if (!merged || merged.length !== 1 || merged[0].length !== 1) continue;
      var candidate = ringToPoly(merged[0][0]);
      candidate = clipPolyToEnvelope(candidate);
      if (!candidate || candidate.length < 3) continue;
      if (growthHitsAnotherBox(candidate, poly, el, o2, live, settled)) continue;
      poly = candidate;
    }}

    // Whatever the gap fill grew, the rotated rooms' own footprints come
    // back out of it -- the fill reaches toward them, so it always needs
    // trimming. Falling back to the GROWN shape when a cut isn't drawable
    // would leave a room visibly overlapping the rotated one, so the
    // fallbacks step down to the plain rectangle instead: it can only fail
    // to carve in exactly the cases canAbsorbBite also refuses, and there
    // collision has kept the pair apart, so the rectangle is safe to draw.
    var clippers = rotated.map(polyOfBox);
    var carved = subtractPolys(poly, clippers);
    if (carved) return carved;
    var base = rectPolyOf(r);
    carved = subtractPolys(base, clippers);
    return carved || base;
  }}

  function clipPolyToEnvelope(poly) {{
    var box = [[ENV.left, ENV.top], [ENV.right, ENV.top], [ENV.right, ENV.bottom], [ENV.left, ENV.bottom]];
    var out;
    try {{ out = polygonClipping.intersection(polyToGeom(poly), polyToGeom(box)); }}
    catch (err) {{ return poly; }}
    if (!out || out.length !== 1 || out[0].length !== 1) return null;
    return ringToPoly(out[0][0]);
  }}

  function distanceBetweenPolys(a, b) {{
    var best = Infinity;
    for (var i = 0; i < a.length; i++) {{
      for (var j = 0; j < b.length; j++) {{
        var d = distToSegment(a[i][0], a[i][1], b[j], b[(j + 1) % b.length]);
        if (d < best) best = d;
      }}
    }}
    return best;
  }}

  function distToSegment(px, py, a, b) {{
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var len2 = dx * dx + dy * dy;
    var t = len2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    var qx = a[0] + dx * t, qy = a[1] + dy * t;
    return Math.sqrt((px - qx) * (px - qx) + (py - qy) * (py - qy));
  }}

  // A gap fill may only take space nothing else is using. Measured as real
  // intersection area against each other box's settled shape -- testing
  // whether the other box's corners land inside the fill (the old way)
  // misses the common case where two shapes cross without either one's
  // vertices falling in the other.
  function growthHitsAnotherBox(grownPoly, basePoly, el, neighbor, live, settled) {{
    for (var i = 0; i < live.length; i++) {{
      var other = live[i];
      if (other === el || other === neighbor) continue;
      var shape = (settled && settled[i]) ? settled[i] : polyOfBox(other);
      if (intersectionArea(grownPoly, shape) > intersectionArea(basePoly, shape) + 1) return true;
    }}
    return false;
  }}

  function intersectionArea(a, b) {{
    var out;
    try {{ out = polygonClipping.intersection(polyToGeom(a), polyToGeom(b)); }}
    catch (err) {{ return 0; }}
    var total = 0;
    (out || []).forEach(function(poly) {{
      poly.forEach(function(ring, idx) {{
        var area = polyArea(ringToPoly(ring));
        total += idx === 0 ? area : -area;
      }});
    }});
    return total;
  }}

  function applyDisplayShapes() {{
    var live = activeBoxes();
    displayPolys = [];
    // Shaped in order, each against the shapes already settled this pass, so
    // two rooms either side of one slot can't both grow into it.
    for (var i = 0; i < live.length; i++) {{
      var el = live[i];
      var settled = displayPolys.slice();
      for (var j = i + 1; j < live.length; j++) settled.push(polyOfBox(live[j]));
      var poly = morphedPolygonFor(el, live, settled);
      displayPolys.push(poly);
      paintFill(el, poly);
    }}
    window.__polys = displayPolys;
    // Exposed for the test suite (and for debugging a layout by hand):
    // which rooms a rotated box is currently allowed to bite into.
    window.__canAbsorbBite = canAbsorbBite;
    window.__names = live.map(function(el) {{
      var l = el.querySelector('.label');
      return l ? l.textContent : '?';
    }});
  }}

  function paintFill(el, poly) {{
    var fill = el.querySelector('.fill');
    if (!fill) return;
    var r = rectOf(el);
    if (rotationOf(el) || samePolygon(poly, rectPolyOf(r))) {{
      fill.style.left = '0px';
      fill.style.top = '0px';
      fill.style.width = '100%';
      fill.style.height = '100%';
      fill.style.clipPath = '';
      el.classList.remove('morphed');
      return;
    }}
    var b = bboxOf(poly);
    fill.style.left = (b.minX - r.left) + 'px';
    fill.style.top = (b.minY - r.top) + 'px';
    fill.style.width = (b.maxX - b.minX) + 'px';
    fill.style.height = (b.maxY - b.minY) + 'px';
    fill.style.clipPath = 'polygon(' + poly.map(function(pt) {{
      return (pt[0] - b.minX).toFixed(2) + 'px ' + (pt[1] - b.minY).toFixed(2) + 'px';
    }}).join(', ') + ')';
    el.classList.add('morphed');
  }}

  function samePolygon(a, b) {{
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {{
      if (Math.abs(a[i][0] - b[i][0]) > 0.05 || Math.abs(a[i][1] - b[i][1]) > 0.05) return false;
    }}
    return true;
  }}

  // ---- Footprint --------------------------------------------------------
  //
  // The union of every box's DISPLAY polygon -- rooms, corridors, carves and
  // gap fills alike -- so the outline follows a rotated room's real diagonal
  // walls. This used to be ~180 lines of hand-rolled edge splitting, outward
  // probing, endpoint welding and loop stitching, which is where this
  // project's outline bugs kept coming from; polygon-clipping does it in one
  // call and handles the degenerate cases properly.
  function computeFootprintPath() {{
    var polys = displayPolys.length ? displayPolys : activeBoxes().map(polyOfBox);
    if (!polys.length) return '';
    var merged = unionPolys(polys);
    var d = '';
    for (var i = 0; i < merged.length; i++) {{
      var rings = merged[i];
      for (var j = 0; j < rings.length; j++) {{
        var ring = ringToPoly(rings[j]);
        if (ring.length < 3) continue;
        d += 'M ' + ring.map(function(pt) {{
          return pt[0].toFixed(1) + ',' + pt[1].toFixed(1);
        }}).join(' L ') + ' Z ';
      }}
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

  // --- Selection -------------------------------------------------------

  function updateSelectionClasses() {{
    for (var i = 0; i < boxes.length; i++) {{
      boxes[i].classList.remove('selected', 'solo-selected');
    }}
    for (var i2 = 0; i2 < selected.length; i2++) {{
      selected[i2].classList.add('selected');
      if (selected.length === 1) {{ selected[i2].classList.add('solo-selected'); }}
    }}
    renderSchedule();
  }}

  function selectBox(box, additive) {{
    if (additive) {{
      var idx = selected.indexOf(box);
      if (idx === -1) {{ selected.push(box); }} else {{ selected.splice(idx, 1); }}
    }} else if (selected.indexOf(box) === -1 || selected.length > 1) {{
      selected = [box];
    }}
    updateSelectionClasses();
  }}

  // Clicking empty canvas (not a box, not a handle -- those stop
  // propagation on their own mousedown) clears the selection.
  container.addEventListener('mousedown', function(e) {{
    if (e.target === container && selected.length) {{
      selected = [];
      updateSelectionClasses();
    }}
  }});

  // --- Room schedule -----------------------------------------------------
  // Live-synced table of every active box's width/depth in meters. Kept
  // in sync by folding renderSchedule() into refreshDiagram() (called
  // after every move/resize/rotate/delete/reset), but updates existing
  // rows' values in place rather than rebuilding the table each time, so
  // a field the owner is mid-edit in isn't clobbered by something else
  // moving elsewhere on the canvas.

  var scheduleRows = {{}};

  function boxId(box) {{
    if (!box.dataset.scheduleId) {{ box.dataset.scheduleId = 'b' + Math.random().toString(36).slice(2); }}
    return box.dataset.scheduleId;
  }}

  function deleteBoxes(targets) {{
    targets.forEach(function(b) {{ b.dataset.deleted = '1'; b.classList.add('deleted'); }});
    selected = selected.filter(function(b) {{ return targets.indexOf(b) === -1; }});
    updateSelectionClasses();
    refreshDiagram();
  }}

  function applyScheduleEdit(box, axis, meters) {{
    if (!isFinite(meters) || meters <= 0) {{ renderSchedule(); return; }}
    var m = minOf(box);
    var r = rectOf(box);
    var px = meters * PX_PER_METER;
    if (axis === 'w') {{
      px = Math.max(m.w, px);
      box.style.left = (r.left + (r.width - px) / 2) + 'px';
      box.style.width = px + 'px';
    }} else {{
      px = Math.max(m.h, px);
      box.style.top = (r.top + (r.height - px) / 2) + 'px';
      box.style.height = px + 'px';
    }}
    clampToEnvelope(box);
    resolveOverlaps(box);
    refreshDiagram();
  }}

  function renderSchedule() {{
    var tbody = document.getElementById('schedule-body');
    if (!tbody) return;
    var live = activeBoxes();
    var liveIds = {{}};
    live.forEach(function(box) {{ liveIds[boxId(box)] = true; }});

    Object.keys(scheduleRows).forEach(function(id) {{
      if (!liveIds[id]) {{ scheduleRows[id].tr.remove(); delete scheduleRows[id]; }}
    }});

    live.forEach(function(box) {{
      var id = boxId(box);
      var row = scheduleRows[id];
      if (!row) {{
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="schedule-name"></td>' +
          '<td><input type="number" step="0.05" data-axis="w" /></td>' +
          '<td><input type="number" step="0.05" data-axis="h" /></td>' +
          '<td class="schedule-area"></td>' +
          '<td class="schedule-rotation"></td>' +
          '<td><button type="button" class="schedule-delete" title="Delete">&times;</button></td>';
        var wInput = tr.querySelector('input[data-axis="w"]');
        var hInput = tr.querySelector('input[data-axis="h"]');
        wInput.addEventListener('change', function() {{ applyScheduleEdit(box, 'w', parseFloat(wInput.value)); }});
        hInput.addEventListener('change', function() {{ applyScheduleEdit(box, 'h', parseFloat(hInput.value)); }});
        tr.querySelector('.schedule-delete').addEventListener('mousedown', function(ev) {{
          ev.preventDefault();
          ev.stopPropagation();
          var targets = (selected.indexOf(box) !== -1 && selected.length > 1) ? selected.slice() : [box];
          deleteBoxes(targets);
        }});
        tr.addEventListener('click', function(ev) {{
          if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'BUTTON') return;
          selectBox(box, ev.shiftKey);
        }});
        tbody.appendChild(tr);
        row = scheduleRows[id] = {{
          tr: tr, wInput: wInput, hInput: hInput,
          nameCell: tr.querySelector('.schedule-name'),
          areaCell: tr.querySelector('.schedule-area'),
          rotCell: tr.querySelector('.schedule-rotation')
        }};
      }}
      var m = minOf(box), r = rectOf(box);
      var name = (box.querySelector('.label') || {{}}).textContent || '';
      if (row.nameCell.textContent !== name) {{ row.nameCell.textContent = name; }}
      row.wInput.min = (m.w / PX_PER_METER).toFixed(2);
      row.hInput.min = (m.h / PX_PER_METER).toFixed(2);
      if (document.activeElement !== row.wInput) {{ row.wInput.value = (r.width / PX_PER_METER).toFixed(2); }}
      if (document.activeElement !== row.hInput) {{ row.hInput.value = (r.height / PX_PER_METER).toFixed(2); }}
      // Area comes from the DISPLAY polygon, so a room carved by a rotated
      // neighbor reports what it actually has left. Width/depth stay the
      // underlying rectangle -- they're what the inputs edit, and an
      // L-shaped room has no single width to report.
      var idx = live.indexOf(box);
      var shape = displayPolys[idx];
      var areaM2 = shape ? polyArea(shape) / (PX_PER_METER * PX_PER_METER)
                         : (r.width * r.height) / (PX_PER_METER * PX_PER_METER);
      var carved = box.classList.contains('morphed');
      row.areaCell.textContent = areaM2.toFixed(1);
      row.areaCell.title = carved ? 'Shaped around a rotated neighbour' : '';
      row.areaCell.classList.toggle('area-morphed', carved);
      row.rotCell.textContent = rotationOf(box) + '°';
      row.tr.classList.toggle('schedule-row-selected', selected.indexOf(box) !== -1);
    }});
  }}

  // --- Gap closing -------------------------------------------------------
  // If the box being dragged ends up less than GAP_SNAP_PX from a box
  // it's actually facing (their ranges overlap on the other axis) on
  // either axis, snap it the rest of the way to touch that neighbor
  // exactly instead of leaving a sliver of empty space. Independent per
  // axis, and only ever engages for a genuine, positive, small gap — an
  // existing 0-gap (already touching) is left alone.
  function findNearestGapDelta(el, axis) {{
    var r = rectOf(el);
    var live = activeBoxes();
    var bestGap = Infinity, bestDelta = null;
    for (var i = 0; i < live.length; i++) {{
      var other = live[i];
      if (other === el) continue;
      var o = rectOf(other);
      if (axis === 'x') {{
        var yOverlap = Math.min(r.top + r.height, o.top + o.height) - Math.max(r.top, o.top);
        if (yOverlap <= 0) continue;
        var gapRight = o.left - (r.left + r.width);
        if (gapRight > 0.5 && gapRight < GAP_SNAP_PX && gapRight < bestGap) {{ bestGap = gapRight; bestDelta = gapRight; }}
        var gapLeft = r.left - (o.left + o.width);
        if (gapLeft > 0.5 && gapLeft < GAP_SNAP_PX && gapLeft < bestGap) {{ bestGap = gapLeft; bestDelta = -gapLeft; }}
      }} else {{
        var xOverlap = Math.min(r.left + r.width, o.left + o.width) - Math.max(r.left, o.left);
        if (xOverlap <= 0) continue;
        var gapDown = o.top - (r.top + r.height);
        if (gapDown > 0.5 && gapDown < GAP_SNAP_PX && gapDown < bestGap) {{ bestGap = gapDown; bestDelta = gapDown; }}
        var gapUp = r.top - (o.top + o.height);
        if (gapUp > 0.5 && gapUp < GAP_SNAP_PX && gapUp < bestGap) {{ bestGap = gapUp; bestDelta = -gapUp; }}
      }}
    }}
    return bestDelta;
  }}

  function snapToNearbyNeighbors(el) {{
    var dx = findNearestGapDelta(el, 'x');
    if (dx !== null) {{ el.style.left = (parseFloat(el.style.left) + dx) + 'px'; }}
    var dy = findNearestGapDelta(el, 'y');
    if (dy !== null) {{ el.style.top = (parseFloat(el.style.top) + dy) + 'px'; }}
  }}

  // Everything that must be re-derived from scratch after any move,
  // resize, rotate, or delete — never left stale from the initial layout.
  function refreshDiagram() {{
    applyDisplayShapes();
    updateFootprint();
    updateDoorArrows();
    renderSchedule();
  }}

  function onDown(e) {{
    var box = e.currentTarget;
    selectBox(box, e.shiftKey);

    active = box;
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
    snapToNearbyNeighbors(active);
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

  // Spins the whole rotate gesture's target set (just the grabbed box
  // solo, or the entire multi-selection if it's part of one — see
  // onRotateDown) by the same angle delta, each box around its own
  // center, then treats every target exactly like a move: clamp to the
  // envelope, push/shrink anything it now overlaps (via its rotation-
  // inflated effective rect, gated by the true-shape SAT check), and
  // refresh the footprint/door arrows/schedule.
  // Rotation never displaces anything. Every room a turning box runs into
  // either absorbs the bite (canAbsorbBite -- it gives up the overlapping
  // sliver and draws itself carved) or the turn is refused and the box
  // stays at the last angle that worked.
  //
  // Pushing on rotation was the old behaviour and it was the wrong trade:
  // pushes are one-way, so a single awkward angle part-way through a drag
  // would shove the hallway across the plot and nothing put it back, even
  // once the angle you settled on was perfectly absorbable. One turn could
  // scatter an entire plan. Refusing the turn is recoverable -- keep
  // dragging and it picks up again the moment the angle works.
  function rotationIsAllowed(targets) {{
    var live = activeBoxes();
    for (var i = 0; i < targets.length; i++) {{
      var el = targets[i];
      for (var j = 0; j < live.length; j++) {{
        var other = live[j];
        if (other === el || targets.indexOf(other) !== -1) continue;
        if (!rectsOverlap(effectiveRectOf(el), effectiveRectOf(other))) continue;
        if (!boxesTrulyIntersect(el, other)) continue;
        if (!canAbsorbBite(other, el) && !canAbsorbBite(el, other)) return false;
      }}
    }}
    return true;
  }}

  function doRotate(e) {{
    var p = point(e);
    var rot = activeRotate;
    var angle = Math.atan2(p.y - rot.cy, p.x - rot.cx) * 180 / Math.PI + 90;
    var delta = Math.round((angle - rot.startAngle) / 5) * 5;

    var previous = rot.targets.map(function(el) {{
      return {{rotation: el.dataset.rotation || '0', left: el.style.left, top: el.style.top}};
    }});
    for (var i = 0; i < rot.targets.length; i++) {{
      var el = rot.targets[i];
      var newRotation = rot.startRotations[i] + delta;
      el.style.transform = 'rotate(' + newRotation + 'deg)';
      el.dataset.rotation = String(newRotation);
      clampToEnvelope(el);
    }}

    if (!rotationIsAllowed(rot.targets)) {{
      for (var k = 0; k < rot.targets.length; k++) {{
        var back = rot.targets[k], prev = previous[k];
        back.dataset.rotation = prev.rotation;
        back.style.transform = 'rotate(' + prev.rotation + 'deg)';
        back.style.left = prev.left;
        back.style.top = prev.top;
      }}
    }}
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

  // If the grabbed box is part of a multi-selection, every selected box
  // rotates together (each around its own center, by the same delta) —
  // see the module docstring's "Multi-select" section.
  function onRotateDown(e) {{
    e.stopPropagation();
    e.preventDefault();
    var box = e.currentTarget.closest('.draggable');
    var r = box.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var p = point(e);
    var startAngle = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI + 90;
    var targets = (selected.indexOf(box) !== -1 && selected.length > 1) ? selected.slice() : [box];
    activeRotate = {{
      el: box, cx: cx, cy: cy, startAngle: startAngle,
      targets: targets, startRotations: targets.map(rotationOf)
    }};
    targets.forEach(function(t) {{ t.classList.add('dragging'); }});
  }}

  // Deletes the whole selection if the clicked box is part of a
  // multi-selection, otherwise just the clicked box.
  function onDeleteDown(e) {{
    e.stopPropagation();
    e.preventDefault();
    var box = e.currentTarget.closest('.draggable');
    var targets = (selected.indexOf(box) !== -1 && selected.length > 1) ? selected.slice() : [box];
    deleteBoxes(targets);
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
    if (activeRotate) {{ activeRotate.targets.forEach(function(t) {{ t.classList.remove('dragging'); }}); }}
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
    selected = [];
    updateSelectionClasses();
    refreshDiagram();
  }});

  refreshDiagram();
}})();
</script>
</body>
</html>
"""

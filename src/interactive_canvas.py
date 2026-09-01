"""Interactive drag canvas: lets the owner reposition rooms by hand to
explore adjacency, on top of Claude's recommended layout (src.layout).

This is a separate exploration surface from the generated diagram in
app.py: the generated diagram always shows Claude's own recommendation
with full circulation detail; this canvas is the owner's own sandbox for
trying different arrangements. Room sizing and colors never change here —
only position is draggable — and only rooms are draggable; the site
outline, street marker, corridors, and faint recommended-circulation
lines are a static backdrop.

Rendered as a single self-contained HTML/CSS/JS document via
`streamlit.components.v1.html` — plain absolutely-positioned `<div>`s
dragged with vanilla pointer events, entirely inside the browser. There is
deliberately no channel feeding drag state back into Python: an earlier
version tried to keep a third-party canvas component's state in sync with
Streamlit across every rerun, and the round trip was exactly what caused
the flicker/reset the owner reported ("switching between the original
shape and the modified shape"). A page that never sends anything back to
Python during a drag has nothing to desync — dragging is instant, and a
"Reset" button (also pure client-side JS) snaps everything back to
Claude's recommended positions, stored in each room's own data attributes.
"""

from __future__ import annotations

import html as html_module
from typing import Dict, List, Tuple

from src.geometry import BuildableEnvelope
from src.layout import LayoutResult
from src.models import Project, Site
from src.palette import CATEGORY_COLORS

PX_PER_METER = 26.0
MARGIN_PX = 34.0
STREET_LABEL_HEADROOM_PX = 20.0
FONT_STACK = "'Helvetica Neue', Helvetica, Arial, sans-serif"
CANVAS_BACKGROUND = "#fbfbf9"


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


def _static_svg(project: Project, result: LayoutResult) -> str:
    """Site outline, street marker(s), and faint recommended-circulation
    lines, as one non-interactive SVG layer under the room boxes."""
    site = project.site
    width_px = site.width_m * PX_PER_METER
    depth_px = site.depth_m * PX_PER_METER
    top = MARGIN_PX + STREET_LABEL_HEADROOM_PX

    parts = [
        f'<rect x="{MARGIN_PX}" y="{top}" width="{width_px}" height="{depth_px}" '
        f'rx="4" fill="none" stroke="#a8a8a3" stroke-width="1.5" />'
    ]

    for (x0, y0), (x1, y1) in result.circulation_edges:
        cx0, cy0 = _to_canvas_point(x0, y0, site.depth_m)
        cx1, cy1 = _to_canvas_point(x1, y1, site.depth_m)
        parts.append(
            f'<line x1="{cx0:.1f}" y1="{cy0:.1f}" x2="{cx1:.1f}" y2="{cy1:.1f}" '
            f'stroke="#0b0b0b" stroke-width="1" stroke-opacity="0.22" />'
        )

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

    total_w = width_px + 2 * MARGIN_PX
    total_h = depth_px + 2 * MARGIN_PX + STREET_LABEL_HEADROOM_PX
    return f'<svg width="{total_w}" height="{total_h}" style="position:absolute;top:0;left:0;pointer-events:none;">{"".join(parts)}</svg>'


def _corridor_divs(project: Project, result: LayoutResult) -> str:
    divs = []
    for corridor in result.corridors:
        left, top, w, h = _to_canvas_rect(corridor.x_m, corridor.y_m, corridor.width_m, corridor.depth_m, project.site.depth_m)
        divs.append(
            f'<div class="corridor" style="left:{left:.1f}px;top:{top:.1f}px;width:{w:.1f}px;height:{h:.1f}px;"></div>'
        )
    return "".join(divs)


def _room_divs(project: Project, result: LayoutResult, assignments: Dict[str, str]) -> str:
    divs = []
    for room in result.rooms:
        left, top, w, h = _to_canvas_rect(room.x_m, room.y_m, room.width_m, room.depth_m, project.site.depth_m)
        color = CATEGORY_COLORS.get(assignments.get(room.base_name, "category_a"), "#cccccc")
        entry_class = " entry" if room.is_entry else ""
        divs.append(
            f'<div class="room-box{entry_class}" '
            f'style="left:{left:.1f}px;top:{top:.1f}px;width:{w:.1f}px;height:{h:.1f}px;background:{color};" '
            f'data-initial-left="{left:.1f}" data-initial-top="{top:.1f}">'
            f'<span class="label">{_esc(room.name)}</span>'
            f"</div>"
        )
    return "".join(divs)


def render_canvas_html(
    project: Project,
    envelope: BuildableEnvelope,
    result: LayoutResult,
    assignments: Dict[str, str],
) -> str:
    width_px, height_px = canvas_size_px(project.site)

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
    overflow: hidden;
  }}
  #canvas-container {{
    position: relative;
    width: {width_px}px;
    height: {height_px}px;
    background: {CANVAS_BACKGROUND};
  }}
  .corridor {{
    position: absolute;
    box-sizing: border-box;
    border: 1px dashed #b9b9b3;
    background-image: repeating-linear-gradient(45deg, #dcdcd6 0, #dcdcd6 4px, #f2f2ee 4px, #f2f2ee 10px);
  }}
  .room-box {{
    position: absolute;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    border-radius: 8px;
    border: 1px solid rgba(0,0,0,0.35);
    box-shadow: 0 3px 7px rgba(15,23,42,0.22);
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
    touch-action: none;
    padding: 3px;
    transition: box-shadow 0.15s ease;
    z-index: 1;
  }}
  .room-box.dragging {{
    cursor: grabbing;
    box-shadow: 0 7px 16px rgba(15,23,42,0.35);
    z-index: 50;
    transition: none;
  }}
  .room-box.entry {{
    border: 2.5px dashed #0b0b0b;
  }}
  .room-box .label {{
    background: rgba(255,255,255,0.55);
    border-radius: 3px;
    padding: 1px 4px;
    font-size: 13px;
    font-weight: 600;
    color: #111111;
    line-height: 1.15;
  }}
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
  <div id="canvas-container">
    {_static_svg(project, result)}
    {_corridor_divs(project, result)}
    {_room_divs(project, result, assignments)}
  </div>
  <button id="reset-btn" type="button">Reset to recommended positions</button>

<script>
(function() {{
  var container = document.getElementById('canvas-container');
  var active = null, offsetX = 0, offsetY = 0;

  function point(e) {{
    if (e.touches && e.touches.length) {{ return {{x: e.touches[0].clientX, y: e.touches[0].clientY}}; }}
    return {{x: e.clientX, y: e.clientY}};
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
    if (!active) return;
    var p = point(e);
    var cRect = container.getBoundingClientRect();
    var newLeft = p.x - cRect.left - offsetX;
    var newTop = p.y - cRect.top - offsetY;
    newLeft = Math.max(0, Math.min(newLeft, container.clientWidth - active.offsetWidth));
    newTop = Math.max(0, Math.min(newTop, container.clientHeight - active.offsetHeight));
    active.style.left = newLeft + 'px';
    active.style.top = newTop + 'px';
    e.preventDefault();
  }}

  function onUp() {{
    if (active) {{ active.classList.remove('dragging'); }}
    active = null;
  }}

  var rooms = document.querySelectorAll('.room-box');
  for (var i = 0; i < rooms.length; i++) {{
    rooms[i].addEventListener('mousedown', onDown);
    rooms[i].addEventListener('touchstart', onDown, {{passive: false}});
  }}
  document.addEventListener('mousemove', onMove);
  document.addEventListener('touchmove', onMove, {{passive: false}});
  document.addEventListener('mouseup', onUp);
  document.addEventListener('touchend', onUp);

  document.getElementById('reset-btn').addEventListener('click', function() {{
    for (var i = 0; i < rooms.length; i++) {{
      rooms[i].style.left = rooms[i].dataset.initialLeft + 'px';
      rooms[i].style.top = rooms[i].dataset.initialTop + 'px';
    }}
  }});
}})();
</script>
</body>
</html>
"""

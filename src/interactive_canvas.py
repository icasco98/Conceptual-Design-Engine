"""Interactive drag canvas: the *only* zoning diagram this tool renders.

It shows Claude's recommended room grouping and layout (src.layout,
src.layout_plan) — title, color-coded legend, and rationale included — as
draggable boxes the owner can rearrange by hand to explore a different
arrangement. Room and corridor *sizing* and colors never change here —
only position is draggable. Corridors are draggable exactly like rooms
(nothing here is a fixed zone); the site outline, the building footprint
outline, the street marker, and faint recommended-circulation lines are
the only static backdrop.

Dragging a box pushes any other box it would overlap out of the way (and
that box can cascade-push a third one), so two spaces can never end up
overlapping — see `resolveOverlaps` in the generated JS. The box under the
owner's cursor is "pinned": it goes exactly where they drag it and is
never itself pushed by the resolution pass.

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
Claude's recommended positions, stored in each box's own data attributes.
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
    """Site outline, building footprint outline, street marker(s), and
    faint recommended-circulation lines — one non-interactive SVG layer
    under the room/corridor boxes."""
    site = project.site
    width_px = site.width_m * PX_PER_METER
    depth_px = site.depth_m * PX_PER_METER
    top = MARGIN_PX + STREET_LABEL_HEADROOM_PX

    parts = [
        f'<rect x="{MARGIN_PX}" y="{top}" width="{width_px}" height="{depth_px}" '
        f'rx="4" fill="none" stroke="#a8a8a3" stroke-width="1.5" />'
    ]

    if result.footprint:
        canvas_points = [_to_canvas_point(x, y, site.depth_m) for x, y in result.footprint]
        path = " ".join(f"{x:.1f},{y:.1f}" for x, y in canvas_points)
        parts.append(
            f'<polygon points="{path}" fill="rgba(58,58,53,0.06)" '
            f'stroke="#3a3a35" stroke-width="2.5" stroke-linejoin="round" />'
        )

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
    """Corridors are draggable exactly like rooms — see the module
    docstring — so they share `.draggable` and the same data attributes
    that hold each box's recommended (reset) position."""
    divs = []
    for i, corridor in enumerate(result.corridors):
        left, top, w, h = _to_canvas_rect(corridor.x_m, corridor.y_m, corridor.width_m, corridor.depth_m, project.site.depth_m)
        divs.append(
            f'<div class="corridor draggable" '
            f'style="left:{left:.1f}px;top:{top:.1f}px;width:{w:.1f}px;height:{h:.1f}px;" '
            f'data-initial-left="{left:.1f}" data-initial-top="{top:.1f}">'
            f'<span class="label corridor-label">Hallway</span>'
            f"</div>"
        )
    return "".join(divs)


def _room_divs(project: Project, result: LayoutResult, assignments: Dict[str, str]) -> str:
    divs = []
    for room in result.rooms:
        left, top, w, h = _to_canvas_rect(room.x_m, room.y_m, room.width_m, room.depth_m, project.site.depth_m)
        color = CATEGORY_COLORS.get(assignments.get(room.base_name, "category_a"), "#cccccc")
        entry_class = " entry" if room.is_entry else ""
        divs.append(
            f'<div class="room-box draggable{entry_class}" '
            f'style="left:{left:.1f}px;top:{top:.1f}px;width:{w:.1f}px;height:{h:.1f}px;background:{color};" '
            f'data-initial-left="{left:.1f}" data-initial-top="{top:.1f}">'
            f'<span class="label">{_esc(room.name)}</span>'
            f"</div>"
        )
    return "".join(divs)


def _legend_html(category_labels: CategoryLabels) -> str:
    """Category swatches plus the two fixed markers (Hallway, Entry) that
    aren't a 4th color — see src.palette for why."""
    items = []
    for key in ("category_a", "category_b", "category_c"):
        label = getattr(category_labels, key)
        color = CATEGORY_COLORS[key]
        items.append(
            f'<span class="legend-item"><span class="swatch" style="background:{color};"></span>{_esc(label)}</span>'
        )
    items.append('<span class="legend-item"><span class="swatch corridor-swatch"></span>Hallway</span>')
    items.append('<span class="legend-item"><span class="swatch entry-swatch"></span>Entry</span>')
    return "".join(items)


def render_canvas_html(
    project: Project,
    envelope: BuildableEnvelope,
    result: LayoutResult,
    assignments: Dict[str, str],
    layout_plan: LayoutPlan,
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
    <div class="canvas-legend">{_legend_html(layout_plan.category_labels)}</div>
  </div>
  <div id="canvas-container">
    {_static_svg(project, result)}
    {_corridor_divs(project, result)}
    {_room_divs(project, result, assignments)}
  </div>
  <button id="reset-btn" type="button">Reset to recommended positions</button>
  <p class="canvas-rationale">{_esc(layout_plan.rationale)}</p>

<script>
(function() {{
  var container = document.getElementById('canvas-container');
  var boxes = Array.prototype.slice.call(document.querySelectorAll('.draggable'));
  var active = null, offsetX = 0, offsetY = 0;

  function point(e) {{
    if (e.touches && e.touches.length) {{ return {{x: e.touches[0].clientX, y: e.touches[0].clientY}}; }}
    return {{x: e.clientX, y: e.clientY}};
  }}

  function rectOf(el) {{
    return {{
      left: parseFloat(el.style.left),
      top: parseFloat(el.style.top),
      width: el.offsetWidth,
      height: el.offsetHeight
    }};
  }}

  function clamp(v, lo, hi) {{ return Math.max(lo, Math.min(v, hi)); }}

  function overlapAmount(a, b) {{
    var ax2 = a.left + a.width, ay2 = a.top + a.height;
    var bx2 = b.left + b.width, by2 = b.top + b.height;
    var ox = Math.min(ax2, bx2) - Math.max(a.left, b.left);
    var oy = Math.min(ay2, by2) - Math.max(a.top, b.top);
    if (ox <= 0 || oy <= 0) {{ return null; }}
    return {{x: ox, y: oy}};
  }}

  // Pushes every box that overlaps another out of the way so nothing ever
  // ends up overlapping. `pinned` (the box currently under the owner's
  // cursor) always goes exactly where they put it and is never pushed;
  // everything else can cascade-push a third box out of its own way.
  function resolveOverlaps(pinned) {{
    for (var pass = 0; pass < 6; pass++) {{
      var any = false;
      for (var i = 0; i < boxes.length; i++) {{
        var a = boxes[i];
        if (a === pinned) continue;
        for (var j = 0; j < boxes.length; j++) {{
          if (i === j) continue;
          var b = boxes[j];
          var ra = rectOf(a), rb = rectOf(b);
          var ov = overlapAmount(ra, rb);
          if (!ov) continue;
          any = true;
          if (ov.x < ov.y) {{
            var dir = (ra.left + ra.width / 2) < (rb.left + rb.width / 2) ? -1 : 1;
            a.style.left = clamp(ra.left + dir * ov.x, 0, container.clientWidth - ra.width) + 'px';
          }} else {{
            var dirY = (ra.top + ra.height / 2) < (rb.top + rb.height / 2) ? -1 : 1;
            a.style.top = clamp(ra.top + dirY * ov.y, 0, container.clientHeight - ra.height) + 'px';
          }}
        }}
      }}
      if (!any) break;
    }}
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
    newLeft = clamp(newLeft, 0, container.clientWidth - active.offsetWidth);
    newTop = clamp(newTop, 0, container.clientHeight - active.offsetHeight);
    active.style.left = newLeft + 'px';
    active.style.top = newTop + 'px';
    resolveOverlaps(active);
    e.preventDefault();
  }}

  function onUp() {{
    if (active) {{ active.classList.remove('dragging'); }}
    active = null;
  }}

  for (var i = 0; i < boxes.length; i++) {{
    boxes[i].addEventListener('mousedown', onDown);
    boxes[i].addEventListener('touchstart', onDown, {{passive: false}});
  }}
  document.addEventListener('mousemove', onMove);
  document.addEventListener('touchmove', onMove, {{passive: false}});
  document.addEventListener('mouseup', onUp);
  document.addEventListener('touchend', onUp);

  document.getElementById('reset-btn').addEventListener('click', function() {{
    for (var i = 0; i < boxes.length; i++) {{
      boxes[i].style.left = boxes[i].dataset.initialLeft + 'px';
      boxes[i].style.top = boxes[i].dataset.initialTop + 'px';
    }}
  }});
}})();
</script>
</body>
</html>
"""

"""Interactive drag canvas: lets the owner reposition rooms by hand to
explore adjacency, on top of Claude's recommended layout (src.layout).

This is a separate exploration surface from the generated diagram in
app.py: the generated diagram always shows Claude's own recommendation
with full circulation detail; this canvas is the owner's own sandbox for
trying different arrangements. Room sizing and colors never change here —
only position is draggable (resizing is disabled), and only rooms are
draggable — the site outline, street marker, and corridors are a static
backdrop.

State model: `st.session_state["room_positions"]` is the single source of
truth for where each room sits (site-frame meters), keyed by room name.
Every render rebuilds the canvas's `initial_drawing` from that dict, and
every render immediately writes back whatever the canvas reports — so the
loop is self-consistent regardless of whether the underlying component
preserves its own state across a Streamlit rerun. app.py resets
`room_positions` to a fresh pack_rooms() result whenever a new layout_plan
is computed, so a genuinely new recommendation isn't fighting stale drags.
"""

from __future__ import annotations

from typing import Dict, List, Tuple

from src.geometry import BuildableEnvelope
from src.layout import LayoutResult, PlacedRoom
from src.models import Project, Site
from src.palette import CATEGORY_COLORS

PX_PER_METER = 22.0
MARGIN_PX = 24.0


def canvas_size_px(site: Site) -> Tuple[int, int]:
    return (
        int(site.width_m * PX_PER_METER + 2 * MARGIN_PX),
        int(site.depth_m * PX_PER_METER + 2 * MARGIN_PX),
    )


def _to_canvas_rect(x_m: float, y_m: float, w_m: float, d_m: float, site_depth_m: float) -> Tuple[float, float, float, float]:
    """Site-frame meters -> canvas pixels. Canvas y grows downward; site y
    grows toward the front, so this flips y to keep front-at-top, matching
    the static diagram's orientation."""
    left = MARGIN_PX + x_m * PX_PER_METER
    top = MARGIN_PX + (site_depth_m - y_m - d_m) * PX_PER_METER
    return left, top, w_m * PX_PER_METER, d_m * PX_PER_METER


def _from_canvas_point(left_px: float, top_px: float, w_px: float, h_px: float, site_depth_m: float) -> Tuple[float, float]:
    """Inverse of _to_canvas_rect, for a room's (left, top, width, height)
    as reported back by the canvas. Returns the room's site-frame (x_m, y_m)."""
    x_m = (left_px - MARGIN_PX) / PX_PER_METER
    d_m = h_px / PX_PER_METER
    top_m_from_front = (top_px - MARGIN_PX) / PX_PER_METER
    y_m = site_depth_m - top_m_from_front - d_m
    return x_m, y_m


_EDGE_LINE = {
    "front": lambda w, d: ((0, 0), (w, 0)),
    "back": lambda w, d: ((0, d), (w, d)),
    "left": lambda w, d: ((0, 0), (0, d)),
    "right": lambda w, d: ((w, 0), (w, d)),
}


def _static_objects(project: Project, envelope: BuildableEnvelope, corridors) -> List[dict]:
    site = project.site
    width_px = site.width_m * PX_PER_METER
    depth_px = site.depth_m * PX_PER_METER
    objects = [
        {
            "type": "rect",
            "left": MARGIN_PX,
            "top": MARGIN_PX,
            "width": width_px,
            "height": depth_px,
            "fill": "",
            "stroke": "#888888",
            "strokeWidth": 1.5,
            "selectable": False,
            "evented": False,
        }
    ]

    for edge in site.edges:
        if edge.adjacency != "street":
            continue
        (x0, y0), (x1, y1) = _EDGE_LINE[edge.position](width_px, depth_px)
        objects.append(
            {
                "type": "line",
                "x1": 0,
                "y1": 0,
                "x2": x1 - x0,
                "y2": y1 - y0,
                "left": MARGIN_PX + x0,
                "top": MARGIN_PX + y0,
                "stroke": "#c0392b",
                "strokeWidth": 4,
                "selectable": False,
                "evented": False,
            }
        )

    for corridor in corridors:
        left, top, w, h = _to_canvas_rect(corridor.x_m, corridor.y_m, corridor.width_m, corridor.depth_m, site.depth_m)
        objects.append(
            {
                "type": "rect",
                "left": left,
                "top": top,
                "width": w,
                "height": h,
                "fill": "#f2f2f2",
                "stroke": "#999999",
                "strokeWidth": 0.8,
                "selectable": False,
                "evented": False,
            }
        )

    return objects


def _room_group(left: float, top: float, width: float, height: float, text: str, color: str, is_entry: bool) -> dict:
    """`left`/`top` are the group's own top-left corner (fabric.js Group
    semantics with originX/Y="left"/"top") — the child rect/textbox below
    are positioned relative to the group's *center* regardless, which is
    an unrelated, always-on fabric.js convention for group children."""
    stroke = "#0b0b0b" if is_entry else "#333333"
    stroke_width = 3 if is_entry else 1
    stroke_dash = [6, 4] if is_entry else None
    return {
        "type": "group",
        "originX": "left",
        "originY": "top",
        "left": left,
        "top": top,
        "width": width,
        "height": height,
        "hasControls": False,
        "lockScalingX": True,
        "lockScalingY": True,
        "lockRotation": True,
        "objects": [
            {
                "type": "rect",
                "originX": "left",
                "originY": "top",
                "left": -width / 2,
                "top": -height / 2,
                "width": width,
                "height": height,
                "fill": color,
                "stroke": stroke,
                "strokeWidth": stroke_width,
                "strokeDashArray": stroke_dash,
            },
            {
                "type": "textbox",
                "originX": "left",
                "originY": "top",
                "left": -width / 2 + 4,
                "top": -8,
                "width": max(width - 8, 10),
                "fontSize": 13,
                "fill": "#000000",
                "textAlign": "center",
                "text": text,
            },
        ],
    }


def build_initial_drawing(
    project: Project,
    envelope: BuildableEnvelope,
    result: LayoutResult,
    assignments: Dict[str, str],
    room_positions: Dict[str, Tuple[float, float]],
) -> Tuple[dict, List[str]]:
    """Returns (initial_drawing, room_names_in_order) — room_names_in_order
    lines up with the LAST len(room_names_in_order) objects in the drawing,
    which is where every draggable room group is placed."""
    objects = _static_objects(project, envelope, result.corridors)

    room_names: List[str] = []
    for room in result.rooms:
        x_m, y_m = room_positions.get(room.name, (room.x_m, room.y_m))
        left, top, w, h = _to_canvas_rect(x_m, y_m, room.width_m, room.depth_m, project.site.depth_m)
        color = CATEGORY_COLORS.get(assignments.get(room.base_name, "category_a"), "#cccccc")
        objects.append(_room_group(left, top, w, h, room.name, color, room.is_entry))
        room_names.append(room.name)

    return {"version": "4.4.0", "objects": objects}, room_names


def read_back_positions(
    json_data: dict,
    room_names_in_order: List[str],
    site_depth_m: float,
) -> Dict[str, Tuple[float, float]]:
    """Parse the canvas's current object list back into
    {room_name: (x_m, y_m)} site-frame positions, matching the trailing
    N objects (the room groups) to room_names_in_order by position — custom
    properties don't survive the component's JSON round-trip, so index
    order (which the component preserves) is what we rely on instead."""
    objects = json_data.get("objects", [])
    room_objects = objects[-len(room_names_in_order):] if room_names_in_order else []

    positions: Dict[str, Tuple[float, float]] = {}
    for name, obj in zip(room_names_in_order, room_objects):
        # Group "left"/"top" are already the top-left corner (fabric.js
        # Group semantics with originX/Y="left"/"top") — no un-centering
        # needed, unlike the group's own internal children.
        left = obj.get("left", 0.0)
        top = obj.get("top", 0.0)
        width = obj.get("width", 0.0) * obj.get("scaleX", 1.0)
        height = obj.get("height", 0.0) * obj.get("scaleY", 1.0)
        x_m, y_m = _from_canvas_point(left, top, width, height, site_depth_m)
        positions[name] = (x_m, y_m)

    return positions

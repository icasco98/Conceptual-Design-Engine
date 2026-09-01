"""Deterministic room packing into the buildable envelope — no LLM math.

Claude's job (src/layout_plan.py) is limited to grouping rooms into color
categories and suggesting a placement order that expresses adjacency
(rooms that should end up near each other are listed near each other).
This module does the actual arithmetic, following three fixed rules so
every room ends up reachable, not just packed:

1. Circulation is structural. Rooms are placed left-to-right in rows;
   whenever there's more than one row, a corridor strip at the fixed code
   width (1.2m by default) is inserted between consecutive rows, spanning
   the full envelope width — so every room touches a corridor above or
   below it, instead of two rows floating with no shared edge. A room the
   owner described as a "hallway" isn't placed as its own box: it's a
   signal that circulation matters, and the generated corridors ARE that
   circulation, sized to code rather than to whatever the owner (or
   Claude) guessed.
2. The entry always anchors the path. Any room marked as the entry is
   moved to the front of the placement order before packing, so row 0
   always starts at the front door.
3. Every room gets one path back to the entry, hop by hop through actual
   touching neighbors only. `circulation_edges` is built by walking the
   touching-graph breadth-first from the entry (rooms and corridors are
   both nodes; an edge exists only where two rectangles literally share a
   boundary segment) — so an arrow never skips over a room or corridor to
   reach one further away, and each arrow is drawn perpendicular to the
   wall it crosses (a shared vertical edge gets a horizontal arrow, a
   shared horizontal edge gets a vertical one), not a diagonal line to a
   room's center.

Known limitation: a single room wider than the whole envelope isn't
special-cased — it will visually overflow rather than being force-fit.
That's rare for realistic house programs and, more importantly, the
project's own room-vs-envelope area check (src/validation.py) already
warns the owner before it gets to this stage. Likewise, when the room
program is scaled down to fit (see below), the corridor strips scale
with everything else — for a conceptual diagram that's an acceptable
approximation, and the area-exceeds-envelope check already flags the
underlying overflow to the owner.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Tuple

from src.defaults import resolve_footprint
from src.geometry import BuildableEnvelope
from src.models import Project, Room

Point = Tuple[float, float]


@dataclass(frozen=True)
class PlacedRoom:
    name: str
    base_name: str
    room_type: str
    is_entry: bool
    x_m: float
    y_m: float
    width_m: float
    depth_m: float

    @property
    def center(self) -> Point:
        return (self.x_m + self.width_m / 2, self.y_m + self.depth_m / 2)


@dataclass(frozen=True)
class CorridorSegment:
    x_m: float
    y_m: float
    width_m: float
    depth_m: float

    @property
    def center(self) -> Point:
        return (self.x_m + self.width_m / 2, self.y_m + self.depth_m / 2)


@dataclass(frozen=True)
class LayoutResult:
    rooms: List[PlacedRoom]
    corridors: List[CorridorSegment]
    # (from_point, to_point) pairs — draw as arrows to show how to get
    # from the entry to any given room.
    circulation_edges: List[Tuple[Point, Point]]


def _expand_and_order(rooms: List[Room], order: List[str]) -> List[tuple[Room, str]]:
    """Expand Room.count>1 into individual instances (paired with their base
    name, for placement_order/category lookups), drop hallway-type rooms
    (circulation is generated, not placed as a box), sort by `order`, then
    force any entry room(s) to the front. Both sorts are stable, so
    relative order is otherwise preserved."""
    expanded: List[tuple[Room, str]] = []
    for room in rooms:
        if room.room_type == "hallway":
            continue
        if room.count <= 1:
            expanded.append((room, room.name))
        else:
            for i in range(room.count):
                instance = room.model_copy(update={"name": f"{room.name} {i + 1}"})
                expanded.append((instance, room.name))

    if order:
        position = {name: i for i, name in enumerate(order)}
        expanded.sort(key=lambda pair: position.get(pair[1], len(order)))

    expanded.sort(key=lambda pair: 0 if pair[0].is_entry else 1)
    return expanded


def _form_rows(
    footprints: List[tuple[Room, str, float, float]],
    envelope_width: float,
    scale: float,
) -> List[List[tuple[Room, str, float, float]]]:
    rows: List[List[tuple[Room, str, float, float]]] = []
    current: List[tuple[Room, str, float, float]] = []
    row_width = 0.0
    for room, base_name, w, d in footprints:
        w, d = w * scale, d * scale
        if current and row_width + w > envelope_width + 1e-9:
            rows.append(current)
            current = []
            row_width = 0.0
        current.append((room, base_name, w, d))
        row_width += w
    if current:
        rows.append(current)
    return rows


def _layout_from_rows(
    rows: List[List[tuple[Room, str, float, float]]],
    envelope: BuildableEnvelope,
    corridor_width: float,
) -> Tuple[List[tuple[Room, str, float, float, float, float]], List[Tuple[float, float, float, float]], float]:
    """Place rows top-to-bottom with a corridor strip between each pair.
    Returns (placed rooms with x/y, corridor rects, total height used)."""
    placed = []
    corridors: List[Tuple[float, float, float, float]] = []
    y = 0.0
    for i, row in enumerate(rows):
        row_height = max((d for _, _, _, d in row), default=0.0)
        x = 0.0
        for room, base_name, w, d in row:
            placed.append((room, base_name, x, y, w, d))
            x += w
        y += row_height
        if i < len(rows) - 1:
            corridors.append((0.0, y, envelope.width_m, corridor_width))
            y += corridor_width
    return placed, corridors, y


def pack_rooms(
    project: Project,
    envelope: BuildableEnvelope,
    placement_order: Optional[List[str]] = None,
) -> LayoutResult:
    ordered = _expand_and_order(project.rooms, placement_order or [])
    footprints = [
        (room, base_name, *resolve_footprint(room.room_type, room.explicit_width_m, room.explicit_depth_m)[:2])
        for room, base_name in ordered
    ]

    corridor_width = project.hallway_width_m

    def try_layout(scale: float):
        rows = _form_rows(footprints, envelope.width_m, scale)
        return _layout_from_rows(rows, envelope, corridor_width * scale)

    placed, corridors, total_height = try_layout(1.0)
    if total_height > envelope.depth_m > 0:
        placed, corridors, total_height = try_layout(envelope.depth_m / total_height)

    def to_site_coords(x: float, y: float) -> Point:
        return (envelope.left_setback_m + x, envelope.back_setback_m + y)

    placed_rooms = []
    for room, base_name, x, y, w, d in placed:
        site_x, site_y = to_site_coords(x, y)
        placed_rooms.append(
            PlacedRoom(
                name=room.name,
                base_name=base_name,
                room_type=room.room_type,
                is_entry=room.is_entry,
                x_m=site_x,
                y_m=site_y,
                width_m=w,
                depth_m=d,
            )
        )

    corridor_segments = []
    for cx, cy, cw, cd in corridors:
        site_x, site_y = to_site_coords(cx, cy)
        corridor_segments.append(CorridorSegment(x_m=site_x, y_m=site_y, width_m=cw, depth_m=cd))

    circulation_edges = _build_circulation_edges(placed, corridors, to_site_coords)

    return LayoutResult(rooms=placed_rooms, corridors=corridor_segments, circulation_edges=circulation_edges)


Rect = Tuple[float, float, float, float]  # x0, y0, x1, y1


def _touching_edge(a: Rect, b: Rect, tol: float = 1e-6) -> Optional[Tuple[str, Point]]:
    """If rectangles a and b share a boundary segment, return (axis,
    midpoint) — axis is "x" when the shared edge is vertical (the two
    rects sit side by side, so the connecting arrow should run
    horizontally), or "y" when the shared edge is horizontal (stacked,
    arrow runs vertically). None if they don't actually touch."""
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b

    if abs(ax1 - bx0) < tol or abs(bx1 - ax0) < tol:
        y_lo, y_hi = max(ay0, by0), min(ay1, by1)
        if y_hi - y_lo > tol:
            shared_x = bx0 if abs(ax1 - bx0) < tol else ax0
            return ("x", (shared_x, (y_lo + y_hi) / 2))

    if abs(ay1 - by0) < tol or abs(by1 - ay0) < tol:
        x_lo, x_hi = max(ax0, bx0), min(ax1, bx1)
        if x_hi - x_lo > tol:
            shared_y = by0 if abs(ay1 - by0) < tol else ay0
            return ("y", ((x_lo + x_hi) / 2, shared_y))

    return None


def _perpendicular_arrow(
    axis: str, midpoint: Point, from_center: Point, to_center: Point, inset: float = 0.35
) -> Tuple[Point, Point]:
    """A short arrow crossing straight through `midpoint`, perpendicular to
    the shared wall, pointing from the `from_` side to the `to_` side."""
    mx, my = midpoint
    if axis == "x":
        from_sign = -1.0 if from_center[0] < mx else 1.0
        return (mx + from_sign * inset, my), (mx - from_sign * inset, my)
    from_sign = -1.0 if from_center[1] < my else 1.0
    return (mx, my + from_sign * inset), (mx, my - from_sign * inset)


def _build_circulation_edges(
    placed: List[tuple[Room, str, float, float, float, float]],
    corridors: List[Tuple[float, float, float, float]],
    to_site_coords,
) -> List[Tuple[Point, Point]]:
    """Breadth-first walk of the touching-graph (rooms + corridors as
    nodes, an edge only where two rectangles share a boundary) starting
    from the entry. Each node is connected by exactly one arrow — to
    whichever touching neighbor first reached it — so every arrow is a
    single hop between actual neighbors, never a shortcut past one."""
    entry_index = next((i for i, p in enumerate(placed) if p[0].is_entry), None)
    if entry_index is None:
        return []

    def rect_of(x: float, y: float, w: float, d: float) -> Rect:
        return (x, y, x + w, y + d)

    def center_of(rect: Rect) -> Point:
        x0, y0, x1, y1 = rect
        return ((x0 + x1) / 2, (y0 + y1) / 2)

    nodes: List[Rect] = [rect_of(x, y, w, d) for _, _, x, y, w, d in placed]
    nodes += [rect_of(x, y, w, d) for x, y, w, d in corridors]
    centers = [center_of(rect) for rect in nodes]

    visited = [False] * len(nodes)
    visited[entry_index] = True
    queue = [entry_index]
    edges: List[Tuple[Point, Point]] = []

    while queue:
        current = queue.pop(0)
        for other in range(len(nodes)):
            if visited[other]:
                continue
            touch = _touching_edge(nodes[current], nodes[other])
            if touch is None:
                continue
            visited[other] = True
            axis, midpoint = touch
            start, end = _perpendicular_arrow(axis, midpoint, centers[current], centers[other])
            edges.append((to_site_coords(*start), to_site_coords(*end)))
            queue.append(other)

    return edges

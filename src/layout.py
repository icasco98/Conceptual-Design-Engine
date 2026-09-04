"""Shared layout primitives: the rectangles a plan is made of.

This module used to be the row packer as well -- rooms placed left to right,
wrapping when the next one didn't fit. That packer is gone. It decided what
ended up next to what by width arithmetic, which meant the adjacency the
brief actually asked for was never expressible, let alone honoured;
`src.place` now does placement against the graph in `src.adjacency`.

What is left here is what every placement strategy needs and none of them
should define twice:

  PlacedRoom / CorridorSegment / LayoutResult
      the shape of a finished layout, which `src.interactive_canvas`,
      `src.access` and `src.planner` all read.
  expand_rooms
      what counts as a room -- counts expanded, hallways dropped.
  touching_edge / build_circulation_edges
      the touching graph, walked breadth-first from the entry, and the
      perpendicular arrows drawn across the walls it finds.
  MAX_SHRINK_M
      how far a room may be nudged from its nominal size.

Coordinates are site-frame meters throughout.
"""


from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Tuple

from src.defaults import resolve_footprint
from src.geometry import BuildableEnvelope
from src.models import Project, Room

Point = Tuple[float, float]

# How much smaller (in meters, per dimension) a room may be nudged from its
# nominal size to make the overall footprint more compact. Never applied
# below the room type's own minimum (src/defaults.py).
MAX_SHRINK_M = 0.5


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
    # The room type's real minimum plan size (src/defaults.py) — never the
    # nominal/typical size. Carried through so the interactive canvas can
    # let the owner shrink a room while dragging without ever going smaller
    # than this.
    min_width_m: float
    min_depth_m: float

    @property
    def center(self) -> Point:
        return (self.x_m + self.width_m / 2, self.y_m + self.depth_m / 2)


@dataclass(frozen=True)
class CorridorSegment:
    x_m: float
    y_m: float
    width_m: float
    depth_m: float
    # A corridor's minimum in both directions is the fixed code hallway
    # width itself (src.validation) — unlike rooms, it has no "typical"
    # size to shrink from; nominal *is* the minimum on both axes.
    min_width_m: float
    min_depth_m: float

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
    # Ordered polygon vertices (site-frame meters) tracing the building's
    # own exterior wall line — the union of every room and corridor, not
    # the buildable envelope it sits inside.
    footprint: List[Point]


def expand_rooms(rooms: List[Room]) -> List[tuple[Room, str]]:
    """Expand Room.count>1 into individual instances, paired with the
    program name they came from, and drop hallway-type rooms.

    A hallway in the brief is a signal that circulation matters, not a box
    to place: the generated corridors ARE that circulation, sized to code
    rather than to whatever the owner or Claude guessed. The base name is
    carried alongside so a colour assignment or an adjacency rule written
    about "Bedroom" can still reach "Bedroom 1" and "Bedroom 2".
    """
    expanded: List[tuple[Room, str]] = []
    for room in rooms:
        if room.room_type == "hallway":
            continue
        if room.count <= 1:
            expanded.append((room, room.name))
        else:
            for i in range(room.count):
                expanded.append((room.model_copy(update={"name": f"{room.name} {i + 1}"}), room.name))
    return expanded


Rect = Tuple[float, float, float, float]  # x0, y0, x1, y1


def touching_edge(a: Rect, b: Rect, tol: float = 1e-6) -> Optional[Tuple[str, Point]]:
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


def perpendicular_arrow(
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


def build_circulation_edges(
    placed: List[tuple[Room, str, float, float, float, float, float, float]],
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

    nodes: List[Rect] = [rect_of(x, y, w, d) for _, _, x, y, w, d, _min_w, _min_d in placed]
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
            touch = touching_edge(nodes[current], nodes[other])
            if touch is None:
                continue
            visited[other] = True
            axis, midpoint = touch
            start, end = perpendicular_arrow(axis, midpoint, centers[current], centers[other])
            edges.append((to_site_coords(*start), to_site_coords(*end)))
            queue.append(other)

    return edges

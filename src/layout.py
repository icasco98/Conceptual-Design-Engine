"""Deterministic room packing into the buildable envelope — no LLM math.

Claude's job (src/layout_plan.py) is limited to grouping rooms into color
categories and suggesting a placement order that expresses adjacency
(rooms that should end up near each other are listed near each other).
This module does the actual arithmetic, following three fixed rules so
every room ends up reachable, not just packed:

1. Circulation is structural. Rooms are placed left-to-right in rows;
   whenever there's more than one row, a corridor strip at the fixed code
   width (1.2m by default) is inserted between consecutive rows, spanning
   from x=0 out to whichever of the two rows is wider — enough to touch
   every room in both, without padding out to the full buildable envelope
   when the rooms themselves don't need that width (that padding would
   otherwise show up as a false bulge in the building footprint, below).
   A room the owner described as a "hallway" isn't placed as its own box:
   it's a signal that circulation matters, and the generated corridors ARE
   that circulation, sized to code rather than to whatever the owner (or
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
4. The footprint is compacted, not just packed. Rooms are sized at their
   nominal (explicit or typical) width/depth, but each one may be nudged
   up to MAX_SHRINK_M (0.5m) smaller — width to help it fit an extra room
   into a row instead of forcing a wrap, depth to trim a row down to
   whichever of its rooms actually needs the most depth — and never below
   that room type's real minimum (src/defaults.py). This only ever makes
   the building's footprint smaller, never a room's stated/typical size
   bigger, and a room only shrinks when doing so genuinely reduces the
   footprint (a room that already fits, or isn't the tallest in its row,
   keeps its nominal size).
5. The building footprint is an exact outline, not the site boundary.
   Every row and corridor is left-aligned at x=0 (rooms within a row are
   placed left-to-right from there; corridors span 0 to the wider of
   their two neighboring rows), so the packing is always a simple
   left-aligned staircase — no general polygon-union math needed to trace
   it. `LayoutResult.footprint` is that staircase's boundary in site-frame
   coordinates: the building's own exterior wall line, which is usually
   narrower than the buildable envelope it sits inside.

Known limitation: a single room wider than the whole envelope isn't
special-cased — it will visually overflow rather than being force-fit.
That's rare for realistic house programs and, more importantly, the
project's own room-vs-envelope area check (src/validation.py) already
warns the owner before it gets to this stage. If the room program still
doesn't fit after compaction, the existing last-resort fallback (a
uniform proportional scale-down of everything, corridors included) takes
over — unlike the compaction above, that fallback does not respect
per-room minimums, but it only ever engages in a scenario the
area-exceeds-envelope validation check has already flagged to the owner.
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
    footprints: List[tuple[Room, str, float, float, float, float]],
    envelope_width: float,
    max_shrink: float,
) -> List[List[tuple[Room, str, float, float, float, float]]]:
    """Place rooms left-to-right, wrapping into a new row when one doesn't
    fit. Before wrapping, try shrinking the room's width (never below its
    own minimum, never by more than `max_shrink`) to exactly fill the row's
    remaining space instead — one fewer row is a smaller footprint."""
    rows: List[List[tuple[Room, str, float, float, float, float]]] = []
    current: List[tuple[Room, str, float, float, float, float]] = []
    row_width = 0.0
    for room, base_name, w, d, min_w, min_d in footprints:
        if current and row_width + w > envelope_width + 1e-9:
            shrink_floor = max(min_w, w - max_shrink)
            available = envelope_width - row_width
            if available >= shrink_floor - 1e-9:
                w = available
            else:
                rows.append(current)
                current = []
                row_width = 0.0
        current.append((room, base_name, w, d, min_w, min_d))
        row_width += w
    if current:
        rows.append(current)
    return rows


def _row_width(row: List[tuple[Room, str, float, float, float, float]]) -> float:
    return sum(w for _, _, w, _, _, _ in row)


def _layout_from_rows(
    rows: List[List[tuple[Room, str, float, float, float, float]]],
    corridor_width: float,
    max_shrink: float,
) -> Tuple[
    List[tuple[Room, str, float, float, float, float, float, float]],
    List[Tuple[float, float, float, float]],
    float,
    List[Tuple[float, float, float]],
]:
    """Place rows top-to-bottom with a corridor strip between each pair,
    spanning x=0 to whichever of the two neighboring rows is wider (enough
    to touch every room in both, no wider). A row's height is set by its
    deepest room; that room (or rooms, on a tie) gets trimmed toward its
    own minimum (never past it, never by more than `max_shrink`) since a
    shallower row is a smaller footprint — shorter rooms in the same row
    already fit within that height and keep their nominal depth. Returns
    (placed rooms with x/y, corridor rects, total height used, bands —
    (width, y_start, y_end) per row/corridor, for the footprint outline)."""
    placed = []
    corridors: List[Tuple[float, float, float, float]] = []
    bands: List[Tuple[float, float, float]] = []
    row_widths = [_row_width(row) for row in rows]
    y = 0.0
    for i, row in enumerate(rows):
        nominal_height = max((d for _, _, _, d, _, _ in row), default=0.0)
        floors_at_max = [min_d for _, _, _, d, _, min_d in row if abs(d - nominal_height) < 1e-9]
        row_height = max(max(floors_at_max), nominal_height - max_shrink) if floors_at_max else nominal_height
        x = 0.0
        for room, base_name, w, d, min_w, min_d in row:
            d_final = row_height if abs(d - nominal_height) < 1e-9 else d
            placed.append((room, base_name, x, y, w, d_final, min_w, min_d))
            x += w
        bands.append((row_widths[i], y, y + row_height))
        y += row_height
        if i < len(rows) - 1:
            corridor_span = max(row_widths[i], row_widths[i + 1])
            corridors.append((0.0, y, corridor_span, corridor_width))
            bands.append((corridor_span, y, y + corridor_width))
            y += corridor_width
    return placed, corridors, y, bands


def _footprint_polygon(bands: List[Tuple[float, float, float]]) -> List[Point]:
    """`bands` are (width, y_start, y_end) — contiguous in y from 0, each
    left-aligned at x=0 (see module docstring, rule 5). Traces the
    right-side staircase boundary and closes back down x=0."""
    if not bands:
        return []
    points: List[Point] = [(0.0, 0.0)]
    prev_width: Optional[float] = None
    for width, y_start, y_end in bands:
        if prev_width is None or abs(width - prev_width) > 1e-9:
            points.append((width, y_start))
        points.append((width, y_end))
        prev_width = width
    points.append((0.0, points[-1][1]))
    return points


def pack_rooms(
    project: Project,
    envelope: BuildableEnvelope,
    placement_order: Optional[List[str]] = None,
) -> LayoutResult:
    ordered = _expand_and_order(project.rooms, placement_order or [])
    footprints = [
        (room, base_name, *resolve_footprint(room.room_type, room.explicit_width_m, room.explicit_depth_m))
        for room, base_name in ordered
    ]

    corridor_width = project.hallway_width_m

    rows = _form_rows(footprints, envelope.width_m, MAX_SHRINK_M)
    placed, corridors, _, bands = _layout_from_rows(rows, corridor_width, MAX_SHRINK_M)
    # If it still doesn't fit after compaction, that's left as-is rather
    # than forced smaller — no room ever goes below its real minimum, and
    # src.validation's area-exceeds-envelope check already tells the owner
    # about the underlying overflow in plain language.

    # Row 0 (the entry) is built at local y=0 and subsequent rows increase
    # y going "deeper" into the packing. That should land near the FRONT
    # (street) edge, not the back — so the y-axis is flipped here: local
    # y=0 maps to the far edge of the envelope (front_setback_m in from
    # the site's front edge), and increasing local y moves back towards
    # back_setback_m. `to_site_coords` takes a plain point; a rectangle's
    # own origin needs `y + its own depth` passed in (see below) so the
    # flip lands on the correct (smaller-y) corner.
    def to_site_coords(x: float, y: float) -> Point:
        return (envelope.left_setback_m + x, envelope.back_setback_m + envelope.depth_m - y)

    placed_rooms = []
    for room, base_name, x, y, w, d, min_w, min_d in placed:
        site_x, site_y = to_site_coords(x, y + d)
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
                min_width_m=min_w,
                min_depth_m=min_d,
            )
        )

    corridor_segments = []
    for cx, cy, cw, cd in corridors:
        site_x, site_y = to_site_coords(cx, cy + cd)
        corridor_segments.append(
            CorridorSegment(
                x_m=site_x, y_m=site_y, width_m=cw, depth_m=cd, min_width_m=corridor_width, min_depth_m=corridor_width
            )
        )

    circulation_edges = _build_circulation_edges(placed, corridors, to_site_coords)
    footprint = [to_site_coords(x, y) for x, y in _footprint_polygon(bands)]

    return LayoutResult(
        rooms=placed_rooms,
        corridors=corridor_segments,
        circulation_edges=circulation_edges,
        footprint=footprint,
    )


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
            touch = _touching_edge(nodes[current], nodes[other])
            if touch is None:
                continue
            visited[other] = True
            axis, midpoint = touch
            start, end = _perpendicular_arrow(axis, midpoint, centers[current], centers[other])
            edges.append((to_site_coords(*start), to_site_coords(*end)))
            queue.append(other)

    return edges

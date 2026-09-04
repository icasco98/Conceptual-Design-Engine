"""Graph geometry over a plan's rectangles.

Everything here answers a question about *which rectangles touch which* and
what follows from it: the door arrows drawn on the diagram, the justified
depth of every room from the entry (space syntax's measure of privacy), the
gap between two rooms, and the outline of the union of all of them. None of
it knows what a zone is; `src/validator.py` and `src/scoring.py` put the
architectural meaning on the numbers.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

from src.access import Node, access_for, rects_touch
from src.plan_types import CorridorSegment, PlacedRoom, Point, Rect

# How far each door arrow's endpoints sit from the wall it crosses. The
# canvas JS uses the same value (DOOR_INSET_M in src/interactive_canvas.py).
DOOR_INSET_M = 0.35


def touching_edge(a: Rect, b: Rect, tol: float = 1e-6) -> Optional[Tuple[str, Point]]:
    """If rectangles a and b share a length of boundary, return (axis,
    midpoint): axis "x" when the shared wall is vertical (side by side, so
    the door arrow runs horizontally), "y" when it is horizontal. None if
    they only meet at a corner or not at all."""
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
    axis: str, midpoint: Point, from_center: Point, to_center: Point, inset: float = DOOR_INSET_M
) -> Tuple[Point, Point]:
    """A short arrow through `midpoint`, perpendicular to the shared wall,
    pointing from the `from_` room into the `to_` room."""
    mx, my = midpoint
    if axis == "x":
        from_sign = -1.0 if from_center[0] < mx else 1.0
        return (mx + from_sign * inset, my), (mx - from_sign * inset, my)
    from_sign = -1.0 if from_center[1] < my else 1.0
    return (mx, my + from_sign * inset), (mx, my - from_sign * inset)


def rect_gap(a: Rect, b: Rect) -> float:
    """Shortest distance between two rectangles' boundaries; 0 when they
    touch or overlap."""
    dx = max(a[0] - b[2], b[0] - a[2], 0.0)
    dy = max(a[1] - b[3], b[1] - a[3], 0.0)
    return (dx * dx + dy * dy) ** 0.5


def rects_overlap(a: Rect, b: Rect, tol: float = 1e-6) -> bool:
    """True when two rectangles share interior area (touching edges don't
    count)."""
    return (
        min(a[2], b[2]) - max(a[0], b[0]) > tol
        and min(a[3], b[3]) - max(a[1], b[1]) > tol
    )


def plan_nodes(rooms: Sequence[PlacedRoom], corridors: Sequence[CorridorSegment]) -> List[Node]:
    """The touching-graph nodes of a plan: every room, then every corridor
    (always passable, named "Hallway"/"Hallway n")."""
    nodes: List[Node] = []
    for room in rooms:
        acc = access_for(room.room_type)
        nodes.append(Node(
            name=room.name,
            rect=room.rect,
            passable=acc.passable,
            is_entry=room.is_entry,
            street_access=acc.street_access,
        ))
    for i, corridor in enumerate(corridors, start=1):
        nodes.append(Node(
            name=f"Hallway {i}" if len(corridors) > 1 else "Hallway",
            rect=corridor.rect,
            passable=True,
            is_entry=False,
        ))
    return nodes


def _adjacency(nodes: Sequence[Node]) -> List[List[int]]:
    adjacency: List[List[int]] = [[] for _ in nodes]
    for i in range(len(nodes)):
        for j in range(i + 1, len(nodes)):
            if rects_touch(nodes[i].rect, nodes[j].rect):
                adjacency[i].append(j)
                adjacency[j].append(i)
    return adjacency


def justified_depths(nodes: Sequence[Node]) -> Dict[str, Optional[int]]:
    """Depth of every node from the entry in the justified plan graph: the
    number of doors between the front door and the room, walking only
    through passable spaces. A bedroom off a hall off the entry is at depth
    2. Unreachable nodes are None. This is space syntax's measure of how
    private a room actually is, as opposed to how private it was declared."""
    depths: Dict[str, Optional[int]] = {n.name: None for n in nodes}
    entry = next((i for i, n in enumerate(nodes) if n.is_entry), None)
    if entry is None:
        return depths
    adjacency = _adjacency(nodes)
    depth = [None] * len(nodes)
    depth[entry] = 0
    queue = [entry]
    while queue:
        current = queue.pop(0)
        if not (nodes[current].passable or current == entry):
            continue
        for other in adjacency[current]:
            if depth[other] is not None:
                continue
            depth[other] = depth[current] + 1
            queue.append(other)
    for i, node in enumerate(nodes):
        depths[node.name] = depth[i]
    return depths


def build_circulation_edges(
    rooms: Sequence[PlacedRoom], corridors: Sequence[CorridorSegment]
) -> List[Tuple[Point, Point]]:
    """One door arrow per space, on the tree the justified-graph walk
    produces: breadth-first from the entry through passable spaces only, so
    every arrow crosses a real shared wall and no route is drawn through a
    bedroom, bathroom or garage."""
    nodes = plan_nodes(rooms, corridors)
    entry = next((i for i, n in enumerate(nodes) if n.is_entry), None)
    if entry is None:
        return []
    adjacency = _adjacency(nodes)
    centers = [((r[0] + r[2]) / 2, (r[1] + r[3]) / 2) for r in (n.rect for n in nodes)]
    visited = [False] * len(nodes)
    visited[entry] = True
    queue = [entry]
    edges: List[Tuple[Point, Point]] = []
    while queue:
        current = queue.pop(0)
        if not (nodes[current].passable or current == entry):
            continue
        for other in adjacency[current]:
            if visited[other]:
                continue
            touch = touching_edge(nodes[current].rect, nodes[other].rect)
            if touch is None:
                continue
            visited[other] = True
            axis, midpoint = touch
            edges.append(perpendicular_arrow(axis, midpoint, centers[current], centers[other]))
            queue.append(other)
    return edges


def _key(x: float, y: float) -> Point:
    return (round(x, 6), round(y, 6))


def union_outline(rects: Sequence[Rect], tol: float = 1e-6) -> List[Point]:
    """The outer boundary of the union of axis-aligned rectangles, as an
    ordered list of vertices with collinear points removed.

    Works on the grid the rectangles' own edges define: every cell is either
    inside the union or not, every cell edge between an inside and an
    outside cell is a piece of boundary, and chaining those pieces gives the
    outline. If the union has several pieces the largest is returned."""
    rects = [r for r in rects if r[2] - r[0] > tol and r[3] - r[1] > tol]
    if not rects:
        return []
    xs = sorted({round(v, 6) for r in rects for v in (r[0], r[2])})
    ys = sorted({round(v, 6) for r in rects for v in (r[1], r[3])})
    nx, ny = len(xs) - 1, len(ys) - 1

    def covered(i: int, j: int) -> bool:
        if i < 0 or j < 0 or i >= nx or j >= ny:
            return False
        cx = (xs[i] + xs[i + 1]) / 2
        cy = (ys[j] + ys[j + 1]) / 2
        return any(r[0] <= cx <= r[2] and r[1] <= cy <= r[3] for r in rects)

    inside = [[covered(i, j) for j in range(ny)] for i in range(nx)]

    # Directed boundary pieces, counter-clockwise around the inside.
    outgoing: Dict[Point, List[Point]] = {}

    def add(a: Point, b: Point) -> None:
        outgoing.setdefault(a, []).append(b)

    for i in range(nx):
        for j in range(ny):
            if not inside[i][j]:
                continue
            x0, x1, y0, y1 = xs[i], xs[i + 1], ys[j], ys[j + 1]
            if not (j > 0 and inside[i][j - 1]):
                add(_key(x0, y0), _key(x1, y0))
            if not (i + 1 < nx and inside[i + 1][j]):
                add(_key(x1, y0), _key(x1, y1))
            if not (j + 1 < ny and inside[i][j + 1]):
                add(_key(x1, y1), _key(x0, y1))
            if not (i > 0 and inside[i - 1][j]):
                add(_key(x0, y1), _key(x0, y0))

    loops: List[List[Point]] = []
    while outgoing:
        start = min(outgoing)
        loop = [start]
        current = start
        while True:
            ends = outgoing.get(current)
            if not ends:
                break
            nxt = ends.pop(0)
            if not ends:
                del outgoing[current]
            if nxt == start:
                break
            loop.append(nxt)
            current = nxt
        loops.append(loop)

    def area(loop: List[Point]) -> float:
        total = 0.0
        for k in range(len(loop)):
            x0, y0 = loop[k]
            x1, y1 = loop[(k + 1) % len(loop)]
            total += x0 * y1 - x1 * y0
        return abs(total) / 2

    best = max(loops, key=area)

    # Drop the vertices that sit on a straight run.
    merged: List[Point] = []
    n = len(best)
    for k in range(n):
        prev, cur, nxt = best[k - 1], best[k], best[(k + 1) % n]
        collinear = (
            abs(prev[0] - cur[0]) < tol and abs(cur[0] - nxt[0]) < tol
        ) or (
            abs(prev[1] - cur[1]) < tol and abs(cur[1] - nxt[1]) < tol
        )
        if not collinear:
            merged.append(cur)
    return merged


def polygon_area(points: Sequence[Point]) -> float:
    if len(points) < 3:
        return 0.0
    total = 0.0
    for k in range(len(points)):
        x0, y0 = points[k]
        x1, y1 = points[(k + 1) % len(points)]
        total += x0 * y1 - x1 * y0
    return abs(total) / 2

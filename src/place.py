"""Placement driven by the adjacency graph.

`src.adjacency` states what should touch what. This module turns that into
rectangles. Nothing here reads a room ordering, because an ordering was the
bug: it could only ever say "these two are near each other in a list", and
the geometry had to guess the rest.

The shape of a plan
-------------------
Circulation is a spine running the length of the building, with rooms in
bands either side of it. That is not an aesthetic preference, it is what
makes access checkable: `src.access` says a route may only pass THROUGH a
passable room, so a destination -- a bedroom, a bathroom, a garage -- has to
meet circulation directly or sit behind a room you are allowed to walk
through. Two ranks per side is exactly enough to express both:

    rank 0   fronts the spine. Anything may sit here.
    rank 1   sits behind rank 0, and only where the rank-0 room in front of
             it is passable, so the route spine -> living room -> study is
             legal and spine -> bedroom -> study is never built.

A room therefore touches up to four others -- its two neighbours in its
band, the room across the rank boundary, and the spine -- which is what
lets a graph be satisfied at all. A list gave every room two.

How the graph decides the arrangement
-------------------------------------
1. Must-edges are contracted into clusters (`AdjacencyGraph.clusters`), so
   a hard constraint cannot be split by a later decision.
2. Clusters are assigned to sides and ordered along the spine to maximise
   the weight of satisfied relationships -- `must` outweighing `should`,
   `avoid` pushing apart. Small programs are searched exhaustively; larger
   ones greedily, seeded by the same objective.
3. Inside a cluster, members are ordered and split across the two ranks by
   the same objective, restricted to arrangements that keep every room
   reachable.

Every step optimises one number, `AdjacencyGraph.weight`, so the engine can
be asked afterwards how much of the brief it delivered
(`AdjacencyGraph.satisfaction`) -- and that answer is a fact about the
layout, not a guess.

Sizing
------
The building takes the envelope's proportions at the area the program needs,
solving W/D = envelope W/D against W*D = room area + spine, so it neither
stretches into a bar nor fills a lot the brief doesn't want. Rooms are never
taken below the minimum `src.defaults` gives their type except by the final
scale-to-fit, which only engages for a program that genuinely does not fit
between the setbacks -- a case `src.validation` has already reported.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import permutations
from typing import Dict, List, NamedTuple, Optional, Sequence, Tuple

from src.access import access_for
from src.adjacency import AdjacencyGraph
from src.defaults import resolve_footprint
from src.geometry import BuildableEnvelope
from src.layout import (
    CorridorSegment,
    LayoutResult,
    PlacedRoom,
    Point,
    build_circulation_edges,
    expand_rooms,
)
from src.models import Project, Room

# Below this many rooms a corridor is not circulation, just floor area: a
# two-room plan is entered and walked directly.
SPINE_MIN_ROOMS = 3

# A band narrower than this is a slot, not a room.
MIN_BAND_WIDTH_M = 1.5

# Above this many items an exhaustive search stops being worth the wait, and
# a greedy pass seeded by the same objective takes over. Chosen so a normal
# house program (a dozen rooms, five or six clusters) is searched exactly.
EXHAUSTIVE_LIMIT = 6


class Structure(NamedTuple):
    """The free choices left once the graph has spoken.

    The graph decides what sits next to what. These decide how the result
    meets the site, which the graph has no opinion about.

    spine_axis   "depth" runs the corridor front-to-back; "width" is the
                 same plan transposed, for a wide shallow lot.
    front_zone   which zone claims the street end of the spine.
    """

    spine_axis: str
    front_zone: str

    @property
    def label(self) -> str:
        axis = "front-to-back spine" if self.spine_axis == "depth" else "cross spine"
        return f"{axis}, {self.front_zone} to the street"


SPINE_AXES: Tuple[str, ...] = ("depth", "width")
FRONT_ZONES: Tuple[str, ...] = ("public", "service")

DEFAULT_STRUCTURE = Structure("depth", "public")


def candidate_structures() -> List[Structure]:
    return [Structure(axis, zone) for axis in SPINE_AXES for zone in FRONT_ZONES]


@dataclass
class _Cell:
    room: Room
    base_name: str
    area: float
    min_width_m: float
    min_depth_m: float
    zone: str
    passable: bool
    street_access: bool
    is_entry: bool
    depth_m: float = 0.0

    @property
    def name(self) -> str:
        return self.room.name


@dataclass
class _Cluster:
    """Rooms the brief said must touch, placed as one unit."""

    members: List[_Cell]
    rank0: List[_Cell] = field(default_factory=list)
    rank1: List[_Cell] = field(default_factory=list)

    @property
    def names(self) -> List[str]:
        return [cell.name for cell in self.members]

    @property
    def area(self) -> float:
        return sum(cell.area for cell in self.members)

    @property
    def has_entry(self) -> bool:
        return any(cell.is_entry for cell in self.members)

    @property
    def street_access(self) -> bool:
        return any(cell.street_access for cell in self.members)

    def sort_key(self, front_zone: str) -> Tuple[int, str]:
        """Front-to-back position class. The entry leads because the front
        door is the root of every route, and anything that meets the street
        directly follows it -- a garage served from inside the house is a
        garage in the wrong place, whatever else the brief says."""
        if self.has_entry:
            return (0, self.members[0].name)
        if self.street_access:
            return (1, self.members[0].name)
        zones = [cell.zone for cell in self.members]
        if front_zone in zones:
            return (2, self.members[0].name)
        if "private" in zones:
            return (4, self.members[0].name)
        return (3, self.members[0].name)


# --- building the cells ---------------------------------------------------


def build_cells(project: Project) -> List[_Cell]:
    """The room program as area-carrying cells. Counts expanded, hallway
    rooms dropped -- a hallway in the brief is a signal that circulation
    matters, and the spine is that circulation, sized to code rather than
    to whatever was guessed."""
    cells: List[_Cell] = []
    for room, base_name in expand_rooms(project.rooms):
        footprint = resolve_footprint(
            room.room_type, room.explicit_width_m, room.explicit_depth_m
        )
        access = access_for(room.room_type)
        cells.append(
            _Cell(
                room=room,
                base_name=base_name,
                area=footprint.width_m * footprint.depth_m,
                min_width_m=footprint.min_width_m,
                min_depth_m=footprint.min_depth_m,
                zone=access.zone,
                passable=access.passable,
                street_access=access.street_access,
                is_entry=room.is_entry,
            )
        )
    return cells


def instances_by_base(project: Project) -> Dict[str, List[str]]:
    """Program name -> the instance names it expands to, so an adjacency
    rule written about "Bedroom" can reach "Bedroom 1" and "Bedroom 2"."""
    out: Dict[str, List[str]] = {}
    for room, base_name in expand_rooms(project.rooms):
        out.setdefault(base_name, []).append(room.name)
    return out


# --- arranging by graph weight -------------------------------------------


def _band_score(graph: AdjacencyGraph, band: Sequence[_Cell]) -> float:
    """What a single file of rooms is worth: consecutive rooms touch, and
    nothing else in the band does."""
    return sum(graph.weight(band[i].name, band[i + 1].name) for i in range(len(band) - 1))


def _rank_score(graph: AdjacencyGraph, rank0: Sequence[_Cell], rank1: Sequence[_Cell]) -> float:
    """A cluster's worth: both bands, plus what meets across the rank
    boundary. Rank-1 rooms are placed behind the rank-0 room they overlap,
    so the pairing is positional."""
    score = _band_score(graph, rank0) + _band_score(graph, rank1)
    for i, back in enumerate(rank1):
        if i < len(rank0):
            score += graph.weight(rank0[i].name, back.name)
    return score


def _reachable_ranks(rank0: Sequence[_Cell], rank1: Sequence[_Cell]) -> bool:
    """A rank-1 room is only reachable through the rank-0 room in front of
    it, so that room has to be one you may walk through. This is the rule
    that stops the engine building a study behind a bedroom."""
    if not rank1:
        return True
    if len(rank0) < len(rank1):
        return False
    return all(rank0[i].passable for i in range(len(rank1)))


def arrange_cluster(graph: AdjacencyGraph, cluster: _Cluster) -> None:
    """Split a cluster's rooms across the two ranks and order both, keeping
    the arrangement worth the most under the graph.

    Searched exhaustively for a normal cluster; a large one falls back to a
    single band ordered greedily, which is always reachable.
    """
    members = cluster.members
    if len(members) == 1:
        cluster.rank0, cluster.rank1 = list(members), []
        return

    if len(members) > EXHAUSTIVE_LIMIT:
        cluster.rank0, cluster.rank1 = _greedy_band(graph, members), []
        return

    best: Optional[Tuple[float, List[_Cell], List[_Cell]]] = None
    passable_count = sum(1 for cell in members if cell.passable)

    for order in permutations(members):
        # Rank 1 can hold at most as many rooms as there are passable rooms
        # to sit in front of them, and never more than half the cluster.
        for back_count in range(0, min(passable_count, len(members) // 2) + 1):
            rank1 = list(order[len(order) - back_count:]) if back_count else []
            rank0 = list(order[: len(order) - back_count])
            if not rank0 or not _reachable_ranks(rank0, rank1):
                continue
            score = _rank_score(graph, rank0, rank1)
            # Prefer a single band when nothing is gained by two: a shallower
            # plan is a simpler plan, and rank 1 costs a room its daylight.
            score -= 0.01 * len(rank1)
            key = (score, [c.name for c in rank0], [c.name for c in rank1])
            if best is None or key[0] > best[0] or (
                key[0] == best[0] and (key[1], key[2]) < ([c.name for c in best[1]], [c.name for c in best[2]])
            ):
                best = (score, rank0, rank1)

    if best is None:
        cluster.rank0, cluster.rank1 = list(members), []
    else:
        _, cluster.rank0, cluster.rank1 = best


def _greedy_band(graph: AdjacencyGraph, cells: Sequence[_Cell]) -> List[_Cell]:
    """Order a band by repeatedly appending whichever room the current end
    pulls hardest on. Deterministic: ties break on name."""
    remaining = sorted(cells, key=lambda cell: cell.name)
    band = [remaining.pop(0)]
    while remaining:
        last = band[-1].name
        remaining.sort(key=lambda cell: (-graph.weight(last, cell.name), cell.name))
        band.append(remaining.pop(0))
    return band


def assign_clusters(
    graph: AdjacencyGraph, clusters: List[_Cluster], front_zone: str
) -> Tuple[List[_Cluster], List[_Cluster]]:
    """Put clusters on the two sides of the spine and order them along it.

    Clusters on the same side and next to each other touch; clusters facing
    each other across the spine do not. So this is the decision that settles
    every remaining relationship the brief asked for, and it is chosen by
    maximising their total weight rather than by a fixed zone order.

    Ordering constraints still bind: the entry leads its side, and anything
    that meets the street stays near the front. They are applied by sorting
    within the chosen assignment, not by overriding it.
    """
    if not clusters:
        return [], []
    if len(clusters) == 1:
        return list(clusters), []

    ordered = sorted(clusters, key=lambda cluster: cluster.sort_key(front_zone))

    def side_score(left: List[_Cluster], right: List[_Cluster]) -> float:
        score = 0.0
        for side in (left, right):
            for i in range(len(side) - 1):
                score += graph.weight_between(side[i].names, side[i + 1].names)
        # Facing clusters do not touch, so an `avoid` pair put on opposite
        # sides is satisfied -- worth counting, or the search has no reason
        # to separate them.
        for cluster_a in left:
            for cluster_b in right:
                for name_a in cluster_a.names:
                    for name_b in cluster_b.names:
                        if graph.strength(name_a, name_b) == "avoid":
                            score += -graph.weight(name_a, name_b)
        return score

    def balance_penalty(left: List[_Cluster], right: List[_Cluster]) -> float:
        left_area = sum(cluster.area for cluster in left)
        right_area = sum(cluster.area for cluster in right)
        total = left_area + right_area
        if total <= 0:
            return 0.0
        # A wildly lopsided plan is a bad plan whatever the graph says: one
        # band ends up a corridor-width strip. Mild, so it only breaks ties
        # between arrangements the graph rates similarly.
        return 3.0 * abs(left_area - right_area) / total

    best: Optional[Tuple[float, List[_Cluster], List[_Cluster]]] = None

    if len(ordered) <= EXHAUSTIVE_LIMIT:
        # The entry's cluster anchors the left side, which removes the
        # mirror-image duplicate of every assignment.
        for mask in range(1 << (len(ordered) - 1)):
            left = [ordered[0]]
            right: List[_Cluster] = []
            for index, cluster in enumerate(ordered[1:]):
                (left if (mask >> index) & 1 else right).append(cluster)
            if not right:
                continue
            score = side_score(left, right) - balance_penalty(left, right)
            if best is None or score > best[0]:
                best = (score, left, right)
    else:
        left, right = [ordered[0]], []
        for cluster in ordered[1:]:
            with_left = side_score(left + [cluster], right) - balance_penalty(left + [cluster], right)
            with_right = side_score(left, right + [cluster]) - balance_penalty(left, right + [cluster])
            (left if with_left >= with_right else right).append(cluster)
        best = (0.0, left, right)

    assert best is not None
    return best[1], best[2]


# --- geometry -------------------------------------------------------------


def _building_depth(total_area: float, hallway_m: float, frame_w: float, frame_d: float) -> float:
    """Solve W*D = area + hallway*D subject to W/D = frame proportions."""
    if frame_d <= 0 or frame_w <= 0 or total_area <= 0:
        return max(frame_d, 0.0)
    k = frame_w / frame_d
    return min((hallway_m + (hallway_m * hallway_m + 4.0 * k * total_area) ** 0.5) / (2.0 * k), frame_d)


def _side_cells(side: Sequence[_Cluster]) -> List[_Cell]:
    out: List[_Cell] = []
    for cluster in side:
        out.extend(cluster.rank0)
        out.extend(cluster.rank1)
    return out


def _side_width(side: Sequence[_Cluster], depth: float) -> float:
    cells = _side_cells(side)
    if not cells:
        return 0.0
    ideal = sum(cell.area for cell in cells) / depth if depth > 0 else 0.0
    floor = max(cell.min_width_m for cell in cells)
    has_ranks = any(cluster.rank1 for cluster in side)
    if has_ranks:
        # Two ranks share the side's width, so each needs room for its own
        # minimum -- a side deep enough for one band is not deep enough for
        # two stacked behind each other.
        floor = max(
            floor,
            max(
                (
                    max(cluster.rank0[i].min_width_m for i in range(len(cluster.rank1)))
                    + max(cell.min_width_m for cell in cluster.rank1)
                )
                for cluster in side
                if cluster.rank1
            ),
        )
    return max(ideal, floor, MIN_BAND_WIDTH_M)


def _cluster_depth(cluster: _Cluster, rank0_width: float, rank1_width: float) -> float:
    """How deep along the spine this cluster runs. Both ranks span it, so it
    is whichever rank needs more."""
    front = sum(max(cell.area / rank0_width, cell.min_depth_m) for cell in cluster.rank0) if rank0_width > 0 else 0.0
    back = sum(max(cell.area / rank1_width, cell.min_depth_m) for cell in cluster.rank1) if rank1_width > 0 else 0.0
    return max(front, back)


def _split_widths(cluster: _Cluster, side_width: float) -> Tuple[float, float]:
    """Divide a side's width between the two ranks by their area, never
    taking either under the widest minimum it has to hold."""
    if not cluster.rank1:
        return side_width, 0.0
    front_area = sum(cell.area for cell in cluster.rank0)
    back_area = sum(cell.area for cell in cluster.rank1)
    total = front_area + back_area
    front = side_width * (front_area / total) if total > 0 else side_width / 2

    front_floor = max(cluster.rank0[i].min_width_m for i in range(len(cluster.rank1)))
    back_floor = max(cell.min_width_m for cell in cluster.rank1)
    front = min(max(front, front_floor), max(side_width - back_floor, front_floor))
    return front, max(side_width - front, 0.0)


def _lay_out_side(
    side: Sequence[_Cluster], x0: float, side_width: float, target_depth: float
) -> List[Tuple[_Cell, float, float, float, float]]:
    """Place one side's rooms as (cell, x, y, width, depth) in the local
    frame, stretched so the side fills the building's depth."""
    if not side or side_width <= 0:
        return []

    widths = [_split_widths(cluster, side_width) for cluster in side]
    depths = [
        _cluster_depth(cluster, front_w, back_w)
        for cluster, (front_w, back_w) in zip(side, widths)
    ]
    total = sum(depths)
    scale = target_depth / total if total > 0 and target_depth > total else 1.0

    placed: List[Tuple[_Cell, float, float, float, float]] = []
    y = 0.0
    for cluster, (front_w, back_w), cluster_depth in zip(side, widths, depths):
        cluster_depth *= scale
        for rank, width, offset in ((cluster.rank0, front_w, 0.0), (cluster.rank1, back_w, front_w)):
            if not rank or width <= 0:
                continue
            rank_area = sum(cell.area for cell in rank)
            inner_y = y
            for index, cell in enumerate(rank):
                share = (cell.area / rank_area) if rank_area > 0 else 1.0 / len(rank)
                depth = cluster_depth * share if index < len(rank) - 1 else (y + cluster_depth) - inner_y
                depth = max(depth, 0.0)
                placed.append((cell, x0 + offset, inner_y, width, depth))
                inner_y += depth
        y += cluster_depth
    return placed


def place_rooms(
    project: Project,
    envelope: BuildableEnvelope,
    graph: Optional[AdjacencyGraph] = None,
    structure: Optional[Structure] = None,
) -> LayoutResult:
    """Lay out the program against the adjacency graph.

    Deterministic: same project, envelope, graph and structure in, same
    rectangles out.
    """
    structure = structure or DEFAULT_STRUCTURE
    cells = build_cells(project)
    if not cells:
        return LayoutResult(rooms=[], corridors=[], circulation_edges=[], footprint=[])

    by_name = {cell.name: cell for cell in cells}
    graph = graph or AdjacencyGraph([cell.name for cell in cells])

    clusters = [
        _Cluster(members=[by_name[name] for name in names if name in by_name])
        for names in graph.clusters()
    ]
    clusters = [cluster for cluster in clusters if cluster.members]
    for cluster in clusters:
        arrange_cluster(graph, cluster)

    left, right = assign_clusters(graph, clusters, structure.front_zone)

    transposed = structure.spine_axis == "width"
    frame_w = envelope.depth_m if transposed else envelope.width_m
    frame_d = envelope.width_m if transposed else envelope.depth_m

    hallway_m = project.hallway_width_m if len(cells) >= SPINE_MIN_ROOMS and left and right else 0.0
    total_area = sum(cell.area for cell in cells)
    depth = _building_depth(total_area, hallway_m, frame_w, frame_d)

    for _ in range(2):
        left_width = _side_width(left, depth)
        right_width = _side_width(right, depth)
        left_depth = sum(_cluster_depth(c, *_split_widths(c, left_width)) for c in left)
        right_depth = sum(_cluster_depth(c, *_split_widths(c, right_width)) for c in right)
        depth = max(left_depth, right_depth, 0.0)

    left_width = _side_width(left, depth)
    right_width = _side_width(right, depth)
    width = left_width + hallway_m + right_width

    laid = _lay_out_side(left, 0.0, left_width, depth)
    laid += _lay_out_side(right, left_width + hallway_m, right_width, depth)

    corridors: List[Tuple[float, float, float, float]] = []
    if hallway_m > 0:
        corridors.append((left_width, 0.0, hallway_m, depth))

    # Measure what was actually laid rather than trusting the widths and
    # depths solved for above. A stack forced deeper by a room's minimum, or
    # a rank split that had to widen for one, leaves those two disagreeing --
    # and scaling against the stale number is how rectangles end up outside
    # the setback line. The extents are the truth; everything else was an
    # estimate on the way to them.
    extents = [(x + w, y + d) for _cell, x, y, w, d in laid] + [
        (x + w, y + d) for x, y, w, d in corridors
    ]
    width = max((e[0] for e in extents), default=0.0)
    depth = max((e[1] for e in extents), default=0.0)

    # Last resort, and only for a program validation has already reported as
    # too big for the site: shrink everything to fit. Unlike every other step
    # this does not respect per-room minimums.
    scale = min(1.0, frame_w / width if width > 0 else 1.0, frame_d / depth if depth > 0 else 1.0)
    if scale < 1.0:
        laid = [(cell, x * scale, y * scale, w * scale, d * scale) for cell, x, y, w, d in laid]
        corridors = [(x * scale, y * scale, w * scale, d * scale) for x, y, w, d in corridors]
        width *= scale
        depth *= scale

    def to_local(x: float, y: float, w: float, d: float) -> Tuple[float, float, float, float]:
        return (y, x, d, w) if transposed else (x, y, w, d)

    # A transposed plan rotates every rectangle a quarter turn, so the room's
    # own minimums rotate with it -- the canvas resizes against them in site
    # coordinates, so they describe the rectangle as drawn.
    placed = [
        (
            cell.room,
            cell.base_name,
            *to_local(x, y, w, d),
            *((cell.min_depth_m, cell.min_width_m) if transposed else (cell.min_width_m, cell.min_depth_m)),
        )
        for cell, x, y, w, d in laid
    ]
    corridors = [to_local(*rect) for rect in corridors]
    if transposed:
        width, depth = depth, width

    def to_site_coords(x: float, y: float) -> Point:
        return (envelope.left_setback_m + x, envelope.back_setback_m + envelope.depth_m - y)

    placed_rooms = [
        PlacedRoom(
            name=room.name,
            base_name=base_name,
            room_type=room.room_type,
            is_entry=room.is_entry,
            x_m=to_site_coords(x, y + d)[0],
            y_m=to_site_coords(x, y + d)[1],
            width_m=w,
            depth_m=d,
            min_width_m=min_w,
            min_depth_m=min_d,
        )
        for room, base_name, x, y, w, d, min_w, min_d in placed
    ]

    corridor_segments = [
        CorridorSegment(
            x_m=to_site_coords(cx, cy + cd)[0],
            y_m=to_site_coords(cx, cy + cd)[1],
            width_m=cw,
            depth_m=cd,
            min_width_m=project.hallway_width_m,
            min_depth_m=project.hallway_width_m,
        )
        for cx, cy, cw, cd in corridors
    ]

    footprint = [
        to_site_coords(0.0, 0.0),
        to_site_coords(width, 0.0),
        to_site_coords(width, depth),
        to_site_coords(0.0, depth),
    ]

    return LayoutResult(
        rooms=placed_rooms,
        corridors=corridor_segments,
        circulation_edges=build_circulation_edges(placed, corridors, to_site_coords),
        footprint=footprint,
    )


def respects_minimums(result: LayoutResult, tolerance: float = 1e-6) -> bool:
    """True when no room was squeezed under its own minimum plan size.

    Only the last-resort scale-to-fit can produce a layout that fails this.
    The score has no term for an undersized room, so a candidate like that
    would otherwise compete as though it were buildable.
    """
    return all(
        room.width_m >= room.min_width_m - tolerance
        and room.depth_m >= room.min_depth_m - tolerance
        for room in result.rooms
    )

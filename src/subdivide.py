"""Slicing-tree room placement: an alternative to `src.layout`'s row packer.

The row packer in `src.layout` places rooms left-to-right and wraps when the
next one doesn't fit. Adjacency is expressed only as position in a list, so
what ends up touching what is decided by width arithmetic. Everything
downstream compensates for that: rooms are shrunk to dodge a wrap, a spine
corridor is bolted on afterwards to reconnect rows the wrapping severed, and
`src.planner` searches over orderings hoping one of them happens to pack
into something walkable.

This module slices instead of packing, and the slicing is chosen so that
access is structural rather than checked-and-repaired:

1. One circulation spine runs the full depth of the building.
2. Rooms are stacked on either side of it, each spanning its side's full
   width.

Because a room spans its whole side, its edge along the spine is its whole
edge -- so EVERY room touches the corridor, and `src.access` finds nothing
to report. The old packer could only discover that property by trying an
ordering and checking; here it is a consequence of the shape.

What the caller varies is the STRUCTURE, not an ordering: which axis the
spine runs along, the front-to-back order of the zones, and how rooms are
split between the two sides. `src.planner` scores those candidates with the
same scoring function it uses for the row packer, so the two strategies are
directly comparable.

Sizing follows from the program rather than from the lot. The building's
proportions are matched to the envelope's, and its area is the room program
plus the spine:

    W / D = envelope width / envelope depth        (match the lot's shape)
    W * D = total room area + hallway width * D    (area the program needs)

which solves for a depth D that is neither a long thin bar nor a square
stretched to fill a lot the program doesn't need. Rooms are then given
their nominal area at their side's width, never taken below the room type's
own minimum (`src.defaults`), and the shorter side is padded out so the
building stays a clean rectangle -- rooms may end up larger than typical,
never smaller than their minimum.

Known limitation: a slicing tree cannot express a pinwheel, where four
rooms rotate around a center. That needs a true rectangular dual of the
adjacency graph (planar triangulation, regular edge labeling), which is
considerably more machinery than a house plan usually earns. Every layout
this module produces is sliceable by construction.

Last resort: if the program still doesn't fit the envelope, everything is
scaled down uniformly -- which, like the equivalent fallback in
`src.layout`, does not respect per-room minimums. It only engages in a
scenario `src.validation`'s area-exceeds-envelope check has already flagged
to the owner.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, NamedTuple, Optional, Sequence, Tuple

from src.access import access_for
from src.defaults import resolve_footprint
from src.geometry import BuildableEnvelope
# _expand_and_order and _build_circulation_edges are shared infrastructure
# rather than row-packer internals -- expanding room counts, dropping
# hallway boxes, and walking the touching graph mean the same thing for any
# placement strategy. Imported rather than duplicated so the two strategies
# cannot drift apart on what a "room" is or how a route is drawn.
from src.layout import (
    CorridorSegment,
    LayoutResult,
    PlacedRoom,
    Point,
    _build_circulation_edges,
    _expand_and_order,
)
from src.models import Project, Room

# Below this many placed rooms a corridor is not circulation, it is just
# floor area: a two-room plan is entered and walked directly.
SPINE_MIN_ROOMS = 3

# A side narrower than this isn't a room, it's a slot. Guards the degenerate
# case where one side gets a single tiny closet and the area split would
# otherwise hand it a few centimetres of width.
MIN_SIDE_WIDTH_M = 1.5

# Front-to-back orders worth trying. The zone a house puts at the front is
# the main structural choice a designer makes, so it is a candidate axis
# rather than a constant.
ZONE_ORDERS: Tuple[Tuple[str, ...], ...] = (
    ("public", "service", "private"),
    ("public", "private", "service"),
    ("service", "public", "private"),
)

SIDE_RULES: Tuple[str, ...] = ("balance", "zone_split")

SPINE_AXES: Tuple[str, ...] = ("depth", "width")


class Structure(NamedTuple):
    """One candidate way to slice the envelope.

    spine_axis  "depth" runs the corridor front-to-back with rooms stacked
                left and right of it; "width" is the same layout transposed,
                which suits a wide shallow lot.
    zone_order  front-to-back order of the public/private/service zones.
                The entry always leads, and rooms that meet the street
                directly (a garage) always follow it, whatever this says.
    side_rule   "balance" fills whichever side has less area so far;
                "zone_split" puts the private zone on its own side.
    """

    spine_axis: str
    zone_order: Tuple[str, ...]
    side_rule: str

    @property
    def label(self) -> str:
        axis = "front-to-back spine" if self.spine_axis == "depth" else "cross spine"
        return f"{axis}, {'/'.join(self.zone_order)}, {self.side_rule}"


def candidate_structures() -> List[Structure]:
    """Every structure worth slicing. Small and enumerable on purpose --
    these are architectural choices, not a search space."""
    return [
        Structure(axis, zone_order, rule)
        for axis in SPINE_AXES
        for zone_order in ZONE_ORDERS
        for rule in SIDE_RULES
    ]


DEFAULT_STRUCTURE = Structure("depth", ZONE_ORDERS[0], "balance")


def respects_minimums(result: LayoutResult, tolerance: float = 1e-6) -> bool:
    """True when no room was squeezed under its own minimum plan size.

    Only the last-resort uniform scale-down can produce a layout that fails
    this, and it engages when a structure doesn't fit the envelope at all --
    a cross spine on a lot far deeper than it is wide, say. `score_layout`
    has no term for undersized rooms, so a candidate like that would
    otherwise be scored on its circulation and compactness as though it were
    buildable. Callers choosing between structures should prefer the ones
    that pass.
    """
    return all(
        room.width_m >= room.min_width_m - tolerance
        and room.depth_m >= room.min_depth_m - tolerance
        for room in result.rooms
    )


@dataclass
class _Cell:
    """A room on its way to becoming a rectangle."""

    room: Room
    base_name: str
    area: float
    min_width_m: float
    min_depth_m: float
    zone: str
    rank: int
    street_access: bool
    # Filled in during placement.
    depth_m: float = 0.0


def _zone_rank(room: Room, structure: Structure) -> int:
    """Front-to-back position class. Lower sits nearer the street.

    The entry leads because the front door is the root of every route. A
    room that meets the street directly follows it: a garage served from
    inside the house is a garage in the wrong place, whatever the zone
    order says.
    """
    if room.is_entry:
        return 0
    access = access_for(room.room_type)
    if access.street_access:
        return 1
    try:
        return 2 + structure.zone_order.index(access.zone)
    except ValueError:
        return 2 + len(structure.zone_order)


def _cells(project: Project, structure: Structure) -> List[_Cell]:
    """The room program as area-carrying cells, ordered front to back."""
    cells: List[_Cell] = []
    for room, base_name in _expand_and_order(project.rooms, []):
        footprint = resolve_footprint(
            room.room_type, room.explicit_width_m, room.explicit_depth_m
        )
        cells.append(
            _Cell(
                room=room,
                base_name=base_name,
                area=footprint.width_m * footprint.depth_m,
                min_width_m=footprint.min_width_m,
                min_depth_m=footprint.min_depth_m,
                zone=access_for(room.room_type).zone,
                rank=_zone_rank(room, structure),
                street_access=access_for(room.room_type).street_access,
            )
        )
    # Stable: rooms keep the program's own order inside a rank.
    cells.sort(key=lambda cell: cell.rank)
    return cells


def _assign_sides(
    cells: Sequence[_Cell], rule: str, cross_spine: bool
) -> Tuple[List[_Cell], List[_Cell]]:
    """Split the ordered cells between the two sides of the spine.

    Both sides keep the front-to-back ordering, so the zone bands line up
    across the corridor -- public rooms opposite public rooms, bedrooms
    opposite bedrooms, which is how a real plan reads.

    What a "side" means depends on the spine. Along a front-to-back spine
    the sides are the two flanks and it is the ordering that decides what
    meets the street; across a cross spine the sides ARE the front and back
    bands, so the side alone decides it. Anything that has to reach the
    street is placed accordingly rather than by one fixed rule.
    """

    def forced(cell: _Cell) -> Optional[str]:
        if cell.room.is_entry:
            return "left"
        if cell.street_access:
            # Front-to-back spine: opposite the entry, so the front door is
            # on one side of the corridor and the garage door on the other,
            # both facing the street. Cross spine: the entry's own side,
            # which is the only one that touches the street at all.
            return "left" if cross_spine else "right"
        return None

    left: List[_Cell] = []
    right: List[_Cell] = []

    if rule == "zone_split":
        for cell in cells:
            side = forced(cell) or ("right" if cell.zone == "private" else "left")
            (left if side == "left" else right).append(cell)
        # A program with no private rooms (or nothing but) collapses to one
        # side, which is not a plan with a corridor down the middle. Fall
        # through to balancing instead of emitting a one-sided building.
        if left and right:
            return left, right
        left, right = [], []

    left_area = right_area = 0.0
    for cell in cells:
        side = forced(cell) or ("left" if left_area <= right_area else "right")
        if side == "left":
            left.append(cell)
            left_area += cell.area
        else:
            right.append(cell)
            right_area += cell.area
    return left, right


def _building_depth(total_area: float, hallway_m: float, frame_w: float, frame_d: float) -> float:
    """Solve W*D = area + hallway*D subject to W/D = frame_w/frame_d.

    Gives the building the lot's proportions at the size the program
    actually needs, instead of stretching it to fill the envelope (a long
    thin bar) or squaring it off regardless of the site.
    """
    if frame_d <= 0 or frame_w <= 0 or total_area <= 0:
        return max(frame_d, 0.0)
    k = frame_w / frame_d
    # k*D^2 - hallway*D - area = 0
    discriminant = hallway_m * hallway_m + 4.0 * k * total_area
    depth = (hallway_m + discriminant ** 0.5) / (2.0 * k)
    return min(depth, frame_d)


def _side_width(side: Sequence[_Cell], depth: float) -> float:
    """Width that gives this side's rooms their nominal area at that depth,
    never narrower than the widest minimum among them."""
    if not side:
        return 0.0
    area = sum(cell.area for cell in side)
    ideal = area / depth if depth > 0 else 0.0
    floor = max(cell.min_width_m for cell in side)
    return max(ideal, floor, MIN_SIDE_WIDTH_M)


def _stack_depths(side: Sequence[_Cell], width: float) -> float:
    """Give each room its area at the side's width, never below the room
    type's own minimum depth. Returns the stack's total depth."""
    total = 0.0
    for cell in side:
        cell.depth_m = max(cell.area / width, cell.min_depth_m) if width > 0 else cell.min_depth_m
        total += cell.depth_m
    return total


def _pad_to(side: Sequence[_Cell], current: float, target: float) -> None:
    """Stretch a shorter stack to the building's depth so the footprint
    stays a rectangle. Only ever grows a room, and only past its nominal
    size -- never below a minimum."""
    if not side or current <= 0 or target <= current:
        return
    scale = target / current
    for cell in side:
        cell.depth_m *= scale


def subdivide_rooms(
    project: Project,
    envelope: BuildableEnvelope,
    structure: Optional[Structure] = None,
) -> LayoutResult:
    """Place every room by slicing the envelope, spine first.

    Deterministic: same project, envelope and structure in, same layout out.
    Produces the same `LayoutResult` as `src.layout.pack_rooms`, so
    `src.access`, `src.planner` and the interactive canvas need no
    knowledge of which strategy drew it.
    """
    structure = structure or DEFAULT_STRUCTURE
    cells = _cells(project, structure)
    if not cells:
        return LayoutResult(rooms=[], corridors=[], circulation_edges=[], footprint=[])

    # The "width" spine is the same construction transposed: solve it in a
    # frame with the envelope's axes swapped, then swap the rectangles back
    # on the way out.
    transposed = structure.spine_axis == "width"
    frame_w = envelope.depth_m if transposed else envelope.width_m
    frame_d = envelope.width_m if transposed else envelope.depth_m

    hallway_m = project.hallway_width_m if len(cells) >= SPINE_MIN_ROOMS else 0.0
    left, right = _assign_sides(cells, structure.side_rule, transposed)

    total_area = sum(cell.area for cell in cells)
    depth = _building_depth(total_area, hallway_m, frame_w, frame_d)

    left_width = _side_width(left, depth)
    right_width = _side_width(right, depth)
    depth = max(_stack_depths(left, left_width), _stack_depths(right, right_width), depth)
    # Widths were solved at the old depth; a stack forced deeper by a room's
    # minimum makes them wider than they need to be, so re-solve once.
    left_width = _side_width(left, depth)
    right_width = _side_width(right, depth)
    left_depth = _stack_depths(left, left_width)
    right_depth = _stack_depths(right, right_width)
    depth = max(left_depth, right_depth)
    _pad_to(left, left_depth, depth)
    _pad_to(right, right_depth, depth)

    width = left_width + hallway_m + right_width

    # Last resort, and only in a case validation has already reported: the
    # program genuinely does not fit between the setbacks.
    #
    # Measured against the FRAME, not the envelope: for a cross spine the
    # two are transposed, and checking the local width against the site's
    # width let those structures run past the setback line entirely.
    scale = min(
        1.0,
        frame_w / width if width > 0 else 1.0,
        frame_d / depth if depth > 0 else 1.0,
    )
    if scale < 1.0:
        left_width *= scale
        right_width *= scale
        hallway_m *= scale
        width *= scale
        depth *= scale
        for cell in cells:
            cell.depth_m *= scale

    placed: List[tuple] = []
    for side, x0, side_width in ((left, 0.0, left_width), (right, left_width + hallway_m, right_width)):
        y = 0.0
        for cell in side:
            placed.append(
                (
                    cell.room,
                    cell.base_name,
                    x0,
                    y,
                    side_width,
                    cell.depth_m,
                    cell.min_width_m,
                    cell.min_depth_m,
                )
            )
            y += cell.depth_m

    corridors: List[Tuple[float, float, float, float]] = []
    if hallway_m > 0 and left and right:
        corridors.append((left_width, 0.0, hallway_m, depth))

    def to_local(x: float, y: float, w: float, d: float) -> Tuple[float, float, float, float]:
        return (y, x, d, w) if transposed else (x, y, w, d)

    # A transposed layout rotates every rectangle a quarter turn, so the
    # room's own minimums rotate with it -- a garage that was 3m across and
    # 6m deep is 6m across and 3m deep once the spine runs the other way.
    # The canvas resizes rooms against these in site coordinates, so they
    # have to describe the rectangle as drawn, not as the room type
    # nominally sits.
    placed = [
        (room, base, *to_local(x, y, w, d), *((min_d, min_w) if transposed else (min_w, min_d)))
        for room, base, x, y, w, d, min_w, min_d in placed
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

    # The building is a rectangle by construction, so the footprint is its
    # four corners -- no staircase to trace.
    footprint = [
        to_site_coords(0.0, 0.0),
        to_site_coords(width, 0.0),
        to_site_coords(width, depth),
        to_site_coords(0.0, depth),
    ]

    return LayoutResult(
        rooms=placed_rooms,
        corridors=corridor_segments,
        circulation_edges=_build_circulation_edges(placed, corridors, to_site_coords),
        footprint=footprint,
    )

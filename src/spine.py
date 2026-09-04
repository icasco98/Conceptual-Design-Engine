"""A second way to pack a plan: a corridor down the middle, rooms either
side of it.

`src.layout` packs rows left to right, wrapping when the next room does not
fit. That is one idea of a house, and because it was the only one, every
plan the tool produced had a family resemblance — and, more damagingly,
every plan varied in the same single direction. Rooms moved left and right;
they barely moved front to back. So a scoring term that wanted a room
*deeper* into the plot — morning sun on a west-facing site, bedrooms off
the road — was choosing between arrangements that were all the same depth,
scored them all equally badly, and changed nothing. The term was not wrong;
it had nothing to choose between.

A spine plan varies in the other direction. Rooms stack front to back down
both sides of the corridor, so depth is what the ordering controls, and the
preferences that need depth finally have something to grip.

It is also how a great many houses are actually organised, and it spends
its circulation better: one corridor that every room opens off, rather than
a strip in each gap between rows.

This module produces exactly what `src.layout.pack_rooms` produces — the
same `LayoutResult`, the same coordinate frame — so `src.planner` can pack
both ways, score them against identical rules, and keep whichever wins. It
returns None rather than a bad plan when the strategy does not suit the
program: a corridor plus two usable sides needs width, and a site too
narrow for that should be packed in rows, not squeezed.
"""

from __future__ import annotations

from src.defaults import resolve_footprint
from src.geometry import BuildableEnvelope
from src.layout import (
    CorridorSegment,
    LayoutResult,
    MultiLevelLayout,
    PlacedRoom,
    Point,
    _build_circulation_edges,
    _footprints_for,
    rooms_on_level,
    stair_of,
)
from src.models import Project

# A side narrower than this cannot hold a real room, whatever the arithmetic
# says, so the strategy declines rather than producing a corridor with
# cupboards down it.
MIN_SIDE_M = 2.4


def _spine_footprint(bands: list[tuple[float, float, float, float]]) -> list[Point]:
    """Trace the outline of a set of (x0, x1, y0, y1) depth bands.

    The row packer's tracer assumes every band starts at x=0, which is true
    when rooms fill from the left edge and false here: a band with a room on
    only one side of the corridor starts partway across. So this one walks
    down the right edge and back up the left.
    """
    if not bands:
        return []
    points: list[Point] = []
    for _x0, x1, y0, y1 in bands:
        if not points or abs(points[-1][0] - x1) > 1e-9:
            points.append((x1, y0))
        points.append((x1, y1))
    for x0, _x1, y0, y1 in reversed(bands):
        if abs(points[-1][0] - x0) > 1e-9:
            points.append((x0, y1))
        points.append((x0, y0))
    return points


def pack_spine_rooms(
    project: Project,
    envelope: BuildableEnvelope,
    placement_order: list[str] | None = None,
    level: int = 0,
) -> LayoutResult | None:
    """Pack one level around a central corridor, or None if it will not fit.

    Rooms are taken two at a time and set facing each other across the
    corridor, one bay after another down the plan: the double-loaded
    corridor, which is what this arrangement is called when a person draws
    it. Consecutive rooms in the ordering therefore always land together --
    either facing across the spine within a bay, or in neighbouring bays.

    That mapping is the reason this strategy can answer to an ordering at
    all, and getting it wrong is subtle. Balancing the two sides room by
    room, always adding to whichever is currently shallower, gives a tidier
    plan and a useless one: which side a room lands on then depends on the
    depths of everything before it rather than on the order, and a pair of
    rooms comes out the same distance apart however they are ordered. Every
    adjacency scored identically across every candidate. Filling one side
    and then the other is worse still -- the two rooms either side of the
    changeover are consecutive in the order and at opposite ends of the
    plan, so asking for them to be near each other actively hurt.
    """
    corridor_width = project.hallway_width_m
    side_width = (envelope.width_m - corridor_width) / 2
    if side_width < MIN_SIDE_M:
        return None

    footprints = _footprints_for(rooms_on_level(project, level), placement_order)
    if not footprints:
        return None

    stair = stair_of(project)
    stair_here = stair is not None and level in stair.levels

    # Rooms open onto the corridor, so the left side is aligned against it
    # rather than against the outer boundary: a room narrower than its side
    # left-aligned at x=0 does not touch the spine at all, and the access
    # check -- correctly -- calls every room on that side unreachable.
    right_x = side_width + corridor_width
    placed: list[tuple] = []
    queue: list[tuple] = []

    if stair_here:
        # The stair is one rectangle on every level, so it is placed from
        # its own footprint rather than from whatever this level's rooms
        # happen to need -- identical on every storey, by construction.
        fp = resolve_footprint("stair", stair.explicit_width_m, stair.explicit_depth_m)
        width = min(fp.width_m, side_width)
        if width < fp.min_width_m:
            return None
        # The stair takes the first bay's left slot, identically on every
        # storey, so the first room in the ordering faces it across the
        # corridor rather than being pushed down the plan by it.
        queue.append((stair, stair.name, min(fp.width_m, side_width), fp.depth_m, fp.min_width_m, fp.min_depth_m))

    for room, base_name, width, depth, min_w, min_d in footprints:
        if room.room_type == "stair":
            continue
        queue.append((room, base_name, width, depth, min_w, min_d))

    y = 0.0
    for i in range(0, len(queue), 2):
        bay = queue[i : i + 2]
        depths = []
        for slot, (room, base_name, width, depth, min_w, min_d) in enumerate(bay):
            fitted = min(width, side_width)
            if fitted < min_w:
                # This room cannot sit beside a corridor on this site. Rows
                # can give it the full width; decline the strategy rather
                # than ship a room below its own minimum.
                return None
            x = side_width - fitted if slot == 0 else right_x
            placed.append((room, base_name, x, y, fitted, depth, min_w, min_d))
            depths.append(depth)
        y += max(depths)

    built_depth = y
    if built_depth <= 0:
        return None

    corridors = [(side_width, 0.0, corridor_width, built_depth)]

    # Depth bands for the outline: at every depth the plan reaches, how far
    # left and right is it actually built?
    # Placed tuples are (room, base_name, x, y, width, depth, min_w, min_d),
    # the same shape the row packer builds, so the shared helpers below can
    # take them unchanged.
    tops = {y for _r, _b, _x, y, _w, _d, _mw, _md in placed}
    bottoms = {y + d for _r, _b, _x, y, _w, d, _mw, _md in placed}
    edges = sorted({0.0, built_depth} | tops | bottoms)

    bands: list[tuple[float, float, float, float]] = []
    for y0, y1 in zip(edges, edges[1:], strict=False):
        mid = (y0 + y1) / 2
        spans = [
            (x, x + w) for _r, _b, x, y, w, d, _mw, _md in placed if y <= mid <= y + d
        ]
        spans.append((side_width, side_width + corridor_width))  # the spine runs the whole depth
        bands.append((min(s[0] for s in spans), max(s[1] for s in spans), y0, y1))

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
                level=level,
            )
        )

    corridor_segments = []
    for cx, cy, cw, cd in corridors:
        site_x, site_y = to_site_coords(cx, cy + cd)
        corridor_segments.append(
            CorridorSegment(
                x_m=site_x,
                y_m=site_y,
                width_m=cw,
                depth_m=cd,
                min_width_m=corridor_width,
                min_depth_m=corridor_width,
            )
        )

    return LayoutResult(
        rooms=placed_rooms,
        corridors=corridor_segments,
        circulation_edges=_build_circulation_edges(placed, corridors, to_site_coords),
        footprint=[to_site_coords(x, y) for x, y in _spine_footprint(bands)],
        level=level,
    )


def pack_spine_levels(
    project: Project,
    envelope: BuildableEnvelope,
    placement_order: list[str] | None = None,
) -> MultiLevelLayout | None:
    """Every storey packed around its own spine, or None if any storey
    cannot take one. All or nothing: half a building organised one way and
    half the other is not a plan anybody would draw."""
    levels = []
    for level in range(project.storeys):
        result = pack_spine_rooms(project, envelope, placement_order, level)
        if result is None:
            return None
        levels.append(result)
    return MultiLevelLayout(levels=levels)

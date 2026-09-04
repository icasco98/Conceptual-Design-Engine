"""A corridor down the middle, rooms either side.

The row packer varies a plan left to right; this one varies it front to
back. These tests pin down the properties that make it worth having: every
room reaches the corridor, the ordering decides the geometry, and the
strategy declines rather than producing a bad plan.
"""

import pytest

from src.access import access_problems_for
from src.geometry import compute_buildable_envelope
from src.layout import MultiLevelLayout
from src.models import Project, Room, Setbacks, Site, SiteEdge
from src.spine import MIN_SIDE_M, pack_spine_levels, pack_spine_rooms

ROOMS = [
    Room(name="Entry", room_type="entry", is_entry=True),
    Room(name="Kitchen", room_type="kitchen"),
    Room(name="Dining", room_type="dining_room"),
    Room(name="Living", room_type="living_room"),
    Room(name="Study", room_type="office"),
]


def make_project(width=24, depth=30, rooms=None) -> Project:
    return Project(
        site=Site(
            width_m=width,
            depth_m=depth,
            edges=[
                SiteEdge(position=p, adjacency="street" if p == "front" else "neighbor")
                for p in ("front", "back", "left", "right")
            ],
        ),
        setbacks=Setbacks(),
        rooms=rooms or ROOMS,
    )


def envelope_for(project):
    return compute_buildable_envelope(project.site, project.setbacks)


def packed(project, order=None):
    return pack_spine_rooms(project, envelope_for(project), order)


def test_every_room_touches_the_corridor():
    """The whole promise of a spine plan. A room set back from the corridor
    opens onto nothing, and the access check calls it unreachable -- which
    is exactly what happened when rooms were aligned to the outer edge
    instead of to the spine.
    """
    project = make_project()
    result = packed(project)
    corridor = result.corridors[0]
    left_edge = corridor.x_m
    right_edge = corridor.x_m + corridor.width_m
    for room in result.rooms:
        touches = (
            abs(room.x_m + room.width_m - left_edge) < 1e-6 or abs(room.x_m - right_edge) < 1e-6
        )
        assert touches, f"{room.name} does not reach the corridor"


def test_a_spine_plan_is_walkable():
    project = make_project()
    assert access_problems_for(MultiLevelLayout(levels=[packed(project)])) == []


def test_the_ordering_decides_the_geometry():
    """A strategy that ignores the ordering gives the planner nothing to
    choose between: every candidate scores the same and every preference
    stops mattering. Two different orderings must place rooms differently.
    """
    project = make_project()
    a = packed(project, ["Entry", "Kitchen", "Dining", "Living", "Study"])
    b = packed(project, ["Entry", "Study", "Living", "Dining", "Kitchen"])
    pos_a = {r.name: (r.x_m, r.y_m) for r in a.rooms}
    pos_b = {r.name: (r.x_m, r.y_m) for r in b.rooms}
    assert pos_a != pos_b


def test_consecutive_rooms_end_up_together():
    """Rooms next to each other in the ordering face each other across the
    corridor, or sit in neighbouring bays. Without that, 'these two belong
    together' has no way to reach the plan.
    """
    project = make_project()
    result = packed(project, ["Entry", "Kitchen", "Dining", "Living", "Study"])
    at = {r.name: r for r in result.rooms}
    facing_gap = abs(at["Entry"].y_m - at["Kitchen"].y_m)
    across_plan = max(r.y_m for r in result.rooms) - min(r.y_m for r in result.rooms)
    assert facing_gap < across_plan / 2


def test_rooms_sit_on_both_sides_of_the_corridor():
    project = make_project()
    result = packed(project)
    corridor = result.corridors[0]
    mid = corridor.x_m + corridor.width_m / 2
    assert any(r.x_m + r.width_m <= mid for r in result.rooms)
    assert any(r.x_m >= mid for r in result.rooms)


def test_one_corridor_serves_the_whole_plan():
    """A spine is one corridor by construction -- that is where its
    circulation efficiency comes from."""
    assert len(packed(make_project()).corridors) == 1


def test_a_site_too_narrow_for_two_sides_declines():
    """Better no plan than a corridor with cupboards down it. The planner
    packs in rows instead."""
    narrow = make_project(width=2 * MIN_SIDE_M)
    assert pack_spine_rooms(narrow, envelope_for(narrow)) is None


def test_a_room_that_cannot_fit_beside_a_corridor_declines():
    """A double garage needs more width than a side gives; rows can hand it
    the whole envelope. Declining says so, rather than shipping a garage
    below its own minimum."""
    project = make_project(width=14, rooms=[*ROOMS, Room(name="Garage", room_type="garage_double")])
    assert pack_spine_rooms(project, envelope_for(project)) is None


def test_the_stair_is_the_same_rectangle_on_every_storey():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True, levels=[0]),
        Room(name="Kitchen", room_type="kitchen", levels=[0]),
        Room(name="Bed", room_type="bedroom", levels=[1]),
        Room(name="Bath", room_type="bathroom", levels=[1]),
        Room(name="Stair", room_type="stair", levels=[0, 1]),
    ]
    project = make_project(rooms=rooms)
    project.storeys = 2
    multi = pack_spine_levels(project, envelope_for(project))
    assert multi is not None
    stairs = [r for level in multi.levels for r in level.rooms if r.room_type == "stair"]
    assert len(stairs) == 2
    first, second = stairs
    assert (first.x_m, first.y_m, first.width_m, first.depth_m) == pytest.approx(
        (second.x_m, second.y_m, second.width_m, second.depth_m)
    )


def test_a_storey_that_cannot_take_a_spine_declines_the_whole_building():
    """Half a building organised one way and half the other is not a plan
    anybody would draw."""
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True, levels=[0]),
        Room(name="Garage", room_type="garage_double", levels=[1]),
    ]
    project = make_project(width=14, rooms=rooms)
    project.storeys = 2
    assert pack_spine_levels(project, envelope_for(project)) is None

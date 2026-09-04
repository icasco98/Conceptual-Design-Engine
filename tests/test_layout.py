"""Shared layout primitives.

The row packer these tests used to cover is gone -- it decided adjacency by
width arithmetic, which is the bug `src.place` and `src.adjacency` exist to
fix. What remains here is what every placement strategy depends on: what
counts as a room, and how two rectangles are judged to touch.
"""

import pytest

from src.geometry import compute_buildable_envelope
from src.layout import (
    build_circulation_edges,
    expand_rooms,
    perpendicular_arrow,
    touching_edge,
)
from src.models import Project, Room, Setbacks, Site, SiteEdge
from src.place import place_rooms


def make_project(width, depth, rooms) -> Project:
    return Project(
        site=Site(width_m=width, depth_m=depth, edges=[
            SiteEdge(position="front", adjacency="street"),
            SiteEdge(position="back", adjacency="neighbor"),
            SiteEdge(position="left", adjacency="neighbor"),
            SiteEdge(position="right", adjacency="neighbor"),
        ]),
        setbacks=Setbacks(),
        rooms=rooms,
    )


# --- what counts as a room ------------------------------------------------


def test_counts_expand_into_named_instances_keeping_their_base_name():
    """The base name is what an adjacency rule or a colour assignment is
    written against, so it has to survive expansion."""
    expanded = expand_rooms([Room(name="Bedroom", room_type="bedroom", count=2)])
    assert [(room.name, base) for room, base in expanded] == [
        ("Bedroom 1", "Bedroom"),
        ("Bedroom 2", "Bedroom"),
    ]


def test_a_single_room_keeps_its_own_name():
    expanded = expand_rooms([Room(name="Kitchen", room_type="kitchen")])
    assert [(room.name, base) for room, base in expanded] == [("Kitchen", "Kitchen")]


def test_hallway_rooms_are_dropped():
    """A hallway in the brief is a signal that circulation matters, not a
    box to place -- the generated corridor is that circulation, at code
    width rather than whatever was guessed."""
    rooms = [
        Room(name="Kitchen", room_type="kitchen"),
        Room(name="Hallway", room_type="hallway"),
    ]
    assert [room.name for room, _ in expand_rooms(rooms)] == ["Kitchen"]


# --- the touching graph ---------------------------------------------------


def test_side_by_side_rectangles_share_a_vertical_edge():
    touch = touching_edge((0, 0, 2, 2), (2, 0, 4, 2))
    assert touch is not None
    axis, (x, y) = touch
    assert axis == "x"
    assert (x, y) == (2, 1)


def test_stacked_rectangles_share_a_horizontal_edge():
    touch = touching_edge((0, 0, 2, 2), (0, 2, 2, 4))
    assert touch is not None
    assert touch[0] == "y"


def test_a_corner_is_not_a_shared_wall():
    """You cannot put a door on a point."""
    assert touching_edge((0, 0, 2, 2), (2, 2, 4, 4)) is None


def test_separated_rectangles_do_not_touch():
    assert touching_edge((0, 0, 2, 2), (3, 0, 5, 2)) is None


def test_arrows_cross_the_wall_perpendicular_not_diagonally():
    start, end = perpendicular_arrow("x", (2.0, 1.0), from_center=(1.0, 1.0), to_center=(3.0, 1.0))
    assert start[1] == end[1] == 1.0, "a vertical wall gets a horizontal arrow"
    assert start[0] < 2.0 < end[0]


def test_no_entry_means_no_circulation_arrows():
    """The walk is rooted at the front door. Without one there is no route
    to draw, which is different from there being no rooms."""
    rooms = [
        Room(name="Kitchen", room_type="kitchen"),
        Room(name="Living Room", room_type="living_room"),
        Room(name="Bedroom", room_type="bedroom"),
    ]
    project = make_project(20, 28, rooms)
    result = place_rooms(project, compute_buildable_envelope(project.site, project.setbacks))
    assert result.rooms
    assert result.circulation_edges == []


def test_circulation_reaches_every_room_in_single_hops():
    """One arrow per room, each between actual neighbours -- never a
    shortcut past one."""
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Living Room", room_type="living_room"),
        Room(name="Kitchen", room_type="kitchen"),
        Room(name="Bedroom", room_type="bedroom", count=2),
        Room(name="Bathroom", room_type="bathroom"),
    ]
    project = make_project(20, 28, rooms)
    result = place_rooms(project, compute_buildable_envelope(project.site, project.setbacks))

    nodes = len(result.rooms) + len(result.corridors)
    assert len(result.circulation_edges) == nodes - 1, "a spanning tree over every box"
    for start, end in result.circulation_edges:
        length = abs(start[0] - end[0]) + abs(start[1] - end[1])
        assert length == pytest.approx(0.7), "a short hop across one wall"

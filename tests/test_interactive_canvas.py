import pytest

from src.geometry import compute_buildable_envelope
from src.interactive_canvas import build_initial_drawing, read_back_positions
from src.layout import pack_rooms
from src.models import Project, Room, Setbacks, Site, SiteEdge


def make_project(width=18.0, depth=25.0, rooms=None) -> Project:
    edges = [
        SiteEdge(position="front", adjacency="street"),
        SiteEdge(position="back", adjacency="neighbor"),
        SiteEdge(position="left", adjacency="neighbor"),
        SiteEdge(position="right", adjacency="neighbor"),
    ]
    site = Site(width_m=width, depth_m=depth, edges=edges)
    return Project(site=site, setbacks=Setbacks(), rooms=rooms or [])


def test_unmoved_round_trip_reproduces_original_positions():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Living Room", room_type="living_room"),
        Room(name="Bedroom", room_type="bedroom_primary", count=3),
    ]
    project = make_project(rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope)

    initial_drawing, room_names = build_initial_drawing(
        project, envelope, result, assignments={}, room_positions={}
    )
    assert len(room_names) == len(result.rooms)

    # Simulate the canvas reporting back exactly what it was given (i.e.
    # nothing was dragged) -- the write/read transforms should be inverses.
    positions = read_back_positions(initial_drawing, room_names, project.site.depth_m)

    for room in result.rooms:
        x_m, y_m = positions[room.name]
        assert x_m == pytest.approx(room.x_m, abs=1e-6)
        assert y_m == pytest.approx(room.y_m, abs=1e-6)


def test_room_positions_override_is_used_when_present():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    project = make_project(rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope)

    moved_x, moved_y = 3.0, 4.0
    overrides = {"Kitchen": (moved_x, moved_y)}
    initial_drawing, room_names = build_initial_drawing(
        project, envelope, result, assignments={}, room_positions=overrides
    )
    positions = read_back_positions(initial_drawing, room_names, project.site.depth_m)

    assert positions["Kitchen"] == pytest.approx((moved_x, moved_y), abs=1e-6)


def test_entry_room_gets_dashed_border_styling():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    project = make_project(rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope)

    initial_drawing, room_names = build_initial_drawing(
        project, envelope, result, assignments={}, room_positions={}
    )
    room_objects = initial_drawing["objects"][-len(room_names):]
    entry_index = room_names.index("Entry")
    entry_rect = room_objects[entry_index]["objects"][0]
    assert entry_rect["strokeDashArray"] is not None


def test_only_rooms_are_selectable_static_backdrop_is_not():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Bedroom", room_type="bedroom_primary", count=4),
    ]
    project = make_project(width=6.0, depth=40.0, rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope)
    assert result.corridors  # sanity: this scenario should have corridors

    initial_drawing, room_names = build_initial_drawing(
        project, envelope, result, assignments={}, room_positions={}
    )
    static_objects = initial_drawing["objects"][: -len(room_names)]
    assert static_objects  # site outline + street + corridors
    for obj in static_objects:
        assert obj.get("selectable") is False
        assert obj.get("evented") is False

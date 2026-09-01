from src.geometry import compute_buildable_envelope
from src.layout import pack_rooms
from src.models import Project, Room, Setbacks, Site, SiteEdge


def make_project(width=20.0, depth=30.0, rooms=None) -> Project:
    edges = [
        SiteEdge(position="front", adjacency="street"),
        SiteEdge(position="back", adjacency="neighbor"),
        SiteEdge(position="left", adjacency="neighbor"),
        SiteEdge(position="right", adjacency="neighbor"),
    ]
    site = Site(width_m=width, depth_m=depth, edges=edges)
    return Project(site=site, setbacks=Setbacks(), rooms=rooms or [])


def _rects(result):
    """Every rectangle on the diagram — rooms and corridors alike — as
    (x0, y0, x1, y1), for overlap/touching checks."""
    boxes = [(r.x_m, r.y_m, r.x_m + r.width_m, r.y_m + r.depth_m) for r in result.rooms]
    boxes += [(c.x_m, c.y_m, c.x_m + c.width_m, c.y_m + c.depth_m) for c in result.corridors]
    return boxes


def _touches(a, b, tol=1e-6) -> bool:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    x_touch = abs(ax1 - bx0) < tol or abs(bx1 - ax0) < tol
    y_overlap = ay0 < by1 - tol and by0 < ay1 - tol
    y_touch = abs(ay1 - by0) < tol or abs(by1 - ay0) < tol
    x_overlap = ax0 < bx1 - tol and bx0 < ax1 - tol
    return (x_touch and y_overlap) or (y_touch and x_overlap)


def _overlaps(a, b, tol=1e-9) -> bool:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    return not (ax1 <= bx0 + tol or bx1 <= ax0 + tol or ay1 <= by0 + tol or by1 <= ay0 + tol)


def test_entry_lands_near_the_front_street_edge_not_the_back():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Bedroom", room_type="bedroom_primary", count=3),
    ]
    project = make_project(width=10.0, depth=20.0, rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope)

    entry = next(r for r in result.rooms if r.is_entry)
    front_edge_y = project.site.depth_m - envelope.front_setback_m
    back_edge_y = envelope.back_setback_m

    assert abs((entry.y_m + entry.depth_m) - front_edge_y) < 1e-6
    assert entry.y_m > (front_edge_y + back_edge_y) / 2


def test_no_overlaps_and_everything_fits_inside_envelope():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Living Room", room_type="living_room"),
        Room(name="Kitchen", room_type="kitchen"),
        Room(name="Primary Bedroom", room_type="bedroom_primary"),
        Room(name="Bedroom", room_type="bedroom", count=2),
        Room(name="Bathroom", room_type="bathroom"),
    ]
    project = make_project(rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope)

    boxes = _rects(result)
    for x0, y0, x1, y1 in boxes:
        assert x0 >= envelope.left_setback_m - 1e-6
        assert y0 >= envelope.back_setback_m - 1e-6
        assert x1 <= envelope.left_setback_m + envelope.width_m + 1e-6
        assert y1 <= envelope.back_setback_m + envelope.depth_m + 1e-6

    for i, a in enumerate(boxes):
        for b in boxes[i + 1 :]:
            assert not _overlaps(a, b)


def test_every_row_boundary_gets_a_connecting_corridor():
    # Enough bedrooms to force at least 3 rows on this lot.
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Bedroom", room_type="bedroom_primary", count=6),
    ]
    project = make_project(width=6.0, depth=40.0, rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope)

    assert len(result.corridors) >= 1

    # Every room touches either another room or a corridor — nothing floats.
    boxes = _rects(result)
    for i, room_box in enumerate([(r.x_m, r.y_m, r.x_m + r.width_m, r.y_m + r.depth_m) for r in result.rooms]):
        touches_something = any(
            _touches(room_box, other) for j, other in enumerate(boxes) if boxes[j] != room_box
        )
        assert touches_something, f"{result.rooms[i].name} isn't touching anything"


def test_hallway_room_is_not_drawn_as_a_box():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Hallway", room_type="hallway"),
        Room(name="Living Room", room_type="living_room"),
    ]
    project = make_project(rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope)

    assert all(r.room_type != "hallway" for r in result.rooms)


def test_entry_is_moved_to_front_regardless_of_placement_order():
    rooms = [
        Room(name="Living Room", room_type="living_room"),
        Room(name="Entry", room_type="entry", is_entry=True),
    ]
    project = make_project(rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope, placement_order=["Living Room", "Entry"])

    assert result.rooms[0].is_entry


def test_circulation_is_a_single_hop_spanning_tree_from_entry():
    # A spanning tree over every room + corridor, built one touching-pair
    # hop at a time, has exactly (nodes - 1) edges — anything less means
    # something didn't get reached; anything more (or a cycle) would mean
    # a redundant/looping connection rather than one clean path per node.
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Bedroom", room_type="bedroom_primary", count=4),
    ]
    project = make_project(width=6.0, depth=40.0, rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope)

    total_nodes = len(result.rooms) + len(result.corridors)
    assert len(result.corridors) >= 1  # this scenario should need multiple rows
    assert len(result.circulation_edges) == total_nodes - 1


def test_circulation_arrows_are_perpendicular_not_diagonal():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Living Room", room_type="living_room"),
        Room(name="Bedroom", room_type="bedroom_primary", count=4),
    ]
    project = make_project(width=8.0, depth=40.0, rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope)

    assert result.circulation_edges
    for (x0, y0), (x1, y1) in result.circulation_edges:
        # Axis-aligned: exactly one coordinate changes, never both (no diagonals).
        assert abs(x0 - x1) < 1e-9 or abs(y0 - y1) < 1e-9


def test_circulation_arrows_are_short_single_hops_not_skips():
    # A skipped-over arrow would span roughly a room's full size; a
    # genuine one-hop arrow only crosses the small inset on either side
    # of the shared wall it's drawn at.
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Bedroom", room_type="bedroom_primary", count=4),
    ]
    project = make_project(width=6.0, depth=40.0, rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope)

    for (x0, y0), (x1, y1) in result.circulation_edges:
        length = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        assert length <= 1.0


def test_no_entry_yields_no_circulation_edges_but_still_packs():
    rooms = [Room(name="Living Room", room_type="living_room")]
    project = make_project(rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope)

    assert result.circulation_edges == []
    assert len(result.rooms) == 1


def test_placement_order_is_respected_within_entry_first_rule():
    rooms = [
        Room(name="A", room_type="other"),
        Room(name="B", room_type="other"),
        Room(name="C", room_type="other"),
    ]
    project = make_project(rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope, placement_order=["C", "A", "B"])

    assert [room.name for room in result.rooms] == ["C", "A", "B"]


def test_count_expands_into_named_instances():
    rooms = [Room(name="Bedroom", room_type="bedroom", count=3)]
    project = make_project(rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope)

    names = {room.name for room in result.rooms}
    assert names == {"Bedroom 1", "Bedroom 2", "Bedroom 3"}
    assert all(room.base_name == "Bedroom" for room in result.rooms)

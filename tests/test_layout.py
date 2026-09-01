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


def test_rooms_dont_overlap_and_stay_inside_envelope():
    rooms = [
        Room(name="Living Room", room_type="living_room"),
        Room(name="Kitchen", room_type="kitchen"),
        Room(name="Primary Bedroom", room_type="bedroom_primary"),
        Room(name="Bedroom", room_type="bedroom", count=2),
        Room(name="Bathroom", room_type="bathroom"),
    ]
    project = make_project(rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    placed = pack_rooms(project, envelope)

    # 6 rooms total: Living, Kitchen, Primary Bedroom, Bedroom 1, Bedroom 2, Bathroom
    assert len(placed) == 6

    for room in placed:
        assert room.x_m >= envelope.left_setback_m - 1e-6
        assert room.y_m >= envelope.back_setback_m - 1e-6
        assert room.x_m + room.width_m <= envelope.left_setback_m + envelope.width_m + 1e-6
        assert room.y_m + room.depth_m <= envelope.back_setback_m + envelope.depth_m + 1e-6

    def overlaps(a, b) -> bool:
        return not (
            a.x_m + a.width_m <= b.x_m + 1e-9
            or b.x_m + b.width_m <= a.x_m + 1e-9
            or a.y_m + a.depth_m <= b.y_m + 1e-9
            or b.y_m + b.depth_m <= a.y_m + 1e-9
        )

    for i, a in enumerate(placed):
        for b in placed[i + 1 :]:
            assert not overlaps(a, b), f"{a.name} overlaps {b.name}"


def test_count_expands_into_named_instances():
    rooms = [Room(name="Bedroom", room_type="bedroom", count=3)]
    project = make_project(rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    placed = pack_rooms(project, envelope)

    names = {room.name for room in placed}
    assert names == {"Bedroom 1", "Bedroom 2", "Bedroom 3"}
    assert all(room.base_name == "Bedroom" for room in placed)


def test_placement_order_is_respected():
    rooms = [
        Room(name="A", room_type="other"),
        Room(name="B", room_type="other"),
        Room(name="C", room_type="other"),
    ]
    project = make_project(rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    placed = pack_rooms(project, envelope, placement_order=["C", "A", "B"])

    assert [room.name for room in placed] == ["C", "A", "B"]


def test_oversized_program_scales_down_to_fit_depth():
    rooms = [Room(name=f"Room {i}", room_type="bedroom_primary") for i in range(6)]
    project = make_project(width=8.0, depth=6.0, rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    placed = pack_rooms(project, envelope)

    max_y = max(room.y_m + room.depth_m for room in placed)
    assert max_y <= envelope.back_setback_m + envelope.depth_m + 1e-6

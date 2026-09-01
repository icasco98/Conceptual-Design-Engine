from src.geometry import compute_buildable_envelope
from src.models import Project, Room, Setbacks, Site, SiteEdge
from src.validation import validate_room_program


def make_project(width=20.0, depth=30.0, rooms=None) -> Project:
    edges = [
        SiteEdge(position="front", adjacency="street"),
        SiteEdge(position="back", adjacency="neighbor"),
        SiteEdge(position="left", adjacency="neighbor"),
        SiteEdge(position="right", adjacency="neighbor"),
    ]
    site = Site(width_m=width, depth_m=depth, edges=edges)
    return Project(site=site, setbacks=Setbacks(), rooms=rooms or [])


def test_no_envelope_yields_no_issues():
    project = Project()  # incomplete site
    issues = validate_room_program(project, envelope=None)
    assert issues == []


def test_room_program_fits_cleanly():
    rooms = [
        Room(name="Primary Bedroom", room_type="bedroom_primary", is_entry=False),
        Room(name="Entry", room_type="entry", is_entry=True),
    ]
    project = make_project(rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    issues = validate_room_program(project, envelope)

    assert not any(i.code == "area_exceeds_envelope" for i in issues)
    assert not any(i.code == "no_entry_marked" for i in issues)


def test_area_exceeds_envelope_flagged_on_tiny_site():
    rooms = [Room(name="Living Room", room_type="living_room")]
    project = make_project(width=4.0, depth=4.0, rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    issues = validate_room_program(project, envelope)

    assert any(i.code == "area_exceeds_envelope" for i in issues)


def test_zero_setback_clearance_flagged_as_invalid_envelope():
    rooms = [Room(name="Entry", room_type="entry")]
    project = make_project(width=2.5, depth=3.0, rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    issues = validate_room_program(project, envelope)

    assert not envelope.is_valid
    assert any(i.code == "envelope_invalid" for i in issues)


def test_missing_entry_flagged():
    rooms = [Room(name="Primary Bedroom", room_type="bedroom_primary")]
    project = make_project(rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    issues = validate_room_program(project, envelope)

    assert any(i.code == "no_entry_marked" for i in issues)


def test_hallway_width_mismatch_flagged():
    rooms = [Room(name="Hallway", room_type="hallway", explicit_width_m=1.5, explicit_depth_m=3.0)]
    project = make_project(rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    issues = validate_room_program(project, envelope)

    assert any(i.code == "hallway_width_mismatch" for i in issues)

"""Station 07: hard constraints, each a test with a name."""

from src.access import access_problems_for
from src.geometry import compute_buildable_envelope
from src.models import Project, Room, Setbacks, Site, SiteEdge
from src.plan_types import CorridorSegment, LayoutResult, PlacedRoom
from src.site_analysis import analyse_site
from src.validator import CIRCULATION_HARD_MAX, validate_plan
from src.zoning import Frame, ZoningPlan, generate_candidates
from src.zoning_spec import Requirement, default_spec, expand_program, expand_requirements


def make_project(rooms, width=20.0, depth=28.0):
    edges = [
        SiteEdge(position="front", adjacency="street"),
        SiteEdge(position="back", adjacency="neighbor"),
        SiteEdge(position="left", adjacency="neighbor"),
        SiteEdge(position="right", adjacency="neighbor"),
    ]
    return Project(site=Site(width_m=width, depth_m=depth, edges=edges), setbacks=Setbacks(), rooms=rooms)


HOUSE = [
    Room(name="Entry", room_type="entry", is_entry=True),
    Room(name="Living", room_type="living_room"),
    Room(name="Kitchen", room_type="kitchen"),
    Room(name="Primary", room_type="bedroom_primary"),
    Room(name="Bedroom", room_type="bedroom", count=2),
    Room(name="Bathroom", room_type="bathroom"),
    Room(name="Garage", room_type="garage_double"),
]


def candidates(project):
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    spec = default_spec(project)
    instances, _ = expand_program(project, spec)
    requirements = expand_requirements(spec, instances)
    frame = Frame(envelope, analyse_site(project).entry_edge)
    return envelope, requirements, generate_candidates(instances, requirements, frame, project.hallway_width_m).plans


def _room(name, x, y, w, d, room_type="bedroom", zone="private", entry=False):
    return PlacedRoom(name, name, room_type, entry, zone, x, y, w, d, 1.0, 1.0)


def _plan(rooms, corridors=()):
    result = LayoutResult(list(rooms), list(corridors), [], [])
    return ZoningPlan(result, "front", ((), ()), (0.0, 0.0), ("left", "right"), bool(corridors), {}, {})


def test_a_good_candidate_passes_and_reports_its_numbers():
    project = make_project(HOUSE)
    envelope, requirements, plans = candidates(project)
    reports = [validate_plan(p, requirements, envelope) for p in plans]
    good = [r for r in reports if r.passed]
    assert good
    assert all(r.private_depth > r.public_depth for r in good)
    assert all(r.circulation_ratio <= CIRCULATION_HARD_MAX for r in good)


def test_depth_is_computed_not_declared():
    """A bedroom straight off the entry sits no deeper than the living room,
    however it is labelled."""
    envelope = compute_buildable_envelope(make_project(HOUSE).site, Setbacks())
    rooms = [
        _room("Entry", 5, 24, 1.2, 2, room_type="entry", zone="public", entry=True),
        _room("Living", 1, 20, 4, 6, room_type="living_room", zone="public"),
        _room("Bedroom", 6.2, 20, 4, 6),
    ]
    report = validate_plan(_plan(rooms), [], envelope)
    assert any("no privacy gradient" in f for f in report.failures)


def test_a_route_through_a_garage_fails_however_deep_the_bedroom_is():
    envelope = compute_buildable_envelope(make_project(HOUSE).site, Setbacks())
    rooms = [
        _room("Entry", 5, 24, 1.2, 2, room_type="entry", zone="public", entry=True),
        _room("Garage", 6.2, 18, 6, 8, room_type="garage_double", zone="service"),
        _room("Bedroom", 6.2, 14, 4, 4),
    ]
    report = validate_plan(_plan(rooms), [], envelope)
    assert any("only way to Bedroom is through Garage" in f for f in report.failures)


def test_a_must_pair_that_does_not_touch_fails():
    envelope = compute_buildable_envelope(make_project(HOUSE).site, Setbacks())
    rooms = [
        _room("Entry", 5, 24, 1.2, 2, room_type="entry", zone="public", entry=True),
        _room("Kitchen", 1, 20, 4, 6, room_type="kitchen", zone="public"),
        _room("Dining", 8, 20, 4, 6, room_type="dining_room", zone="public"),
    ]
    reqs = [Requirement("Kitchen", ("Dining",), "must", "Kitchen", "Dining")]
    report = validate_plan(_plan(rooms), reqs, envelope)
    assert "Kitchen and Dining were required to share a wall and don't." in report.failures


def test_an_apart_pair_that_touches_fails():
    envelope = compute_buildable_envelope(make_project(HOUSE).site, Setbacks())
    rooms = [
        _room("Entry", 5, 24, 1.2, 2, room_type="entry", zone="public", entry=True),
        _room("Living", 2, 20, 4, 6, room_type="living_room", zone="public"),
        _room("Garage", 6, 20, 6, 6, room_type="garage_double", zone="service"),
    ]
    reqs = [Requirement("Living", ("Garage",), "apart", "Living", "Garage")]
    report = validate_plan(_plan(rooms), reqs, envelope)
    assert "Living and Garage were to be kept apart and share a wall." in report.failures


def test_too_much_hallway_fails():
    envelope = compute_buildable_envelope(make_project(HOUSE).site, Setbacks())
    rooms = [
        _room("Entry", 5, 24, 1.2, 2, room_type="entry", zone="public", entry=True),
        _room("Living", 1, 20, 4, 4, room_type="living_room", zone="public"),
    ]
    corridor = CorridorSegment(5, 4, 1.2, 20, 1.2, 1.2)
    report = validate_plan(_plan(rooms, [corridor]), [], envelope)
    assert any("wasted plan" in f for f in report.failures)


def test_crossing_the_setback_line_or_overlapping_fails():
    envelope = compute_buildable_envelope(make_project(HOUSE).site, Setbacks())
    rooms = [
        _room("Entry", 5, 24, 1.2, 2, room_type="entry", zone="public", entry=True),
        _room("Living", 0, 20, 4, 6, room_type="living_room", zone="public"),  # left setback is 1.5
        _room("Kitchen", 3, 20, 4, 6, room_type="kitchen", zone="public"),  # overlaps Living
    ]
    report = validate_plan(_plan(rooms), [], envelope)
    assert "Living crosses the setback line." in report.failures
    assert "Living and Kitchen overlap." in report.failures


def test_a_habitable_room_below_code_minimum_fails():
    envelope = compute_buildable_envelope(make_project(HOUSE).site, Setbacks())
    rooms = [
        _room("Entry", 5, 24, 1.2, 2, room_type="entry", zone="public", entry=True),
        _room("Bedroom", 6.2, 20, 2.0, 3.0),  # 6 m2, 2.0 m across
    ]
    report = validate_plan(_plan(rooms), [], envelope)
    assert any("smaller than a habitable room" in f for f in report.failures)


def test_validator_agrees_with_the_access_module():
    project = make_project(HOUSE)
    envelope, requirements, plans = candidates(project)
    for plan in plans[:20]:
        report = validate_plan(plan, requirements, envelope)
        assert not any("only way" in f or "can't be reached" in f for f in report.failures) or access_problems_for(plan.result)

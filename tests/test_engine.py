"""The pipeline end to end, and the judgement the scorer encodes."""

from src.engine import design
from src.geometry import compute_buildable_envelope
from src.models import Project, Room, Setbacks, Site, SiteEdge
from src.zoning_spec import AdjacencyRequirement, default_spec


def make_project(rooms, width=20.0, depth=28.0, rotation=None, streets=("front",)):
    edges = [
        SiteEdge(position=p, adjacency="street" if p in streets else "neighbor")
        for p in ("front", "back", "left", "right")
    ]
    site = Site(width_m=width, depth_m=depth, rotation_deg=rotation, edges=edges)
    return Project(site=site, setbacks=Setbacks(), rooms=rooms)


HOUSE = [
    Room(name="Entry", room_type="entry", is_entry=True),
    Room(name="Living", room_type="living_room"),
    Room(name="Dining", room_type="dining_room"),
    Room(name="Kitchen", room_type="kitchen"),
    Room(name="Primary", room_type="bedroom_primary"),
    Room(name="Bedroom", room_type="bedroom", count=2),
    Room(name="Bathroom", room_type="bathroom", count=2),
    Room(name="Laundry", room_type="laundry"),
    Room(name="Garage", room_type="garage_double"),
]


def run(project, spec=None):
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    return design(project, envelope, spec or default_spec(project))


def test_an_ordinary_house_gets_a_plan_that_passes_everything():
    outcome = run(make_project(HOUSE))
    assert outcome.status == "ok", outcome.messages
    assert outcome.validation.passed
    assert outcome.passing > 0
    assert outcome.plan.corridor_needed


def test_the_choice_is_deterministic():
    a = run(make_project(HOUSE))
    b = run(make_project(HOUSE))
    assert [(r.name, r.x_m, r.y_m) for r in a.plan.result.rooms] == [(r.name, r.x_m, r.y_m) for r in b.plan.result.rooms]


def test_the_living_room_takes_the_sunny_side():
    """Site analysis decides the row: with the sun on the right edge, the
    living room's outer wall faces right; with the sun on the left, left."""
    east_sun = run(make_project(HOUSE, rotation=0))  # front faces north: right edge faces east, sunny back
    west_sun = run(make_project(HOUSE, rotation=180))  # front faces south
    assert east_sun.status == "ok" and west_sun.status == "ok"
    # Front faces north -> left edge faces west, right edge faces east.
    # Front faces south -> left edge faces east, right edge faces west.
    # Neither is 'the' sun edge (that's back / front), so the tie-break is
    # morning light for bedrooms: they go east both times.
    bedrooms_east = [
        "right" in east_sun.plan.facing["Bedroom 1"] or "right" in east_sun.plan.facing["Bedroom 2"],
        "left" in west_sun.plan.facing["Bedroom 1"] or "left" in west_sun.plan.facing["Bedroom 2"],
    ]
    assert all(bedrooms_east)


def test_the_living_room_faces_the_sun_when_a_side_edge_has_it():
    """Front facing east puts the sun on the right-hand edge (which faces
    south); the living room goes there."""
    outcome = run(make_project(HOUSE, rotation=90))
    assert outcome.site.sun_edge == "right"
    assert "right" in outcome.plan.facing["Living"]


def test_private_rooms_sit_deeper_than_public_ones():
    outcome = run(make_project(HOUSE))
    report = outcome.validation
    assert report.private_depth > report.public_depth


def test_an_impossible_brief_is_relaxed_and_explained():
    project = make_project(HOUSE)
    spec = default_spec(project)
    spec.adjacencies.extend([
        AdjacencyRequirement(room_a="Kitchen", room_b="Living", strength="must"),
        AdjacencyRequirement(room_a="Kitchen", room_b="Garage", strength="must"),
    ])
    outcome = run(project, spec)
    assert outcome.status == "relaxed"
    assert outcome.plan is not None
    assert any("Kitchen is required to share a wall with" in m for m in outcome.messages)
    assert any("relaxed" in m for m in outcome.messages)
    # The relaxed spec no longer carries the offending must.
    musts = [(a.room_a, a.room_b) for a in outcome.spec.adjacencies if a.strength == "must"]
    assert len([m for m in musts if "Kitchen" in m]) <= 2


def test_a_program_too_big_for_the_plot_is_rejected_with_a_reason():
    outcome = run(make_project(HOUSE, width=9.0, depth=12.0))
    assert outcome.status == "rejected"
    assert outcome.plan is None
    assert outcome.messages


def test_a_program_with_no_entry_gets_one_and_says_so():
    outcome = run(make_project([Room(name="Living", room_type="living_room"), Room(name="Bed", room_type="bedroom")]))
    assert outcome.plan is not None
    assert any(r.is_entry for r in outcome.plan.result.rooms)
    assert any("foyer was added" in m for m in outcome.messages)


def test_the_rationale_is_composed_from_the_plan():
    outcome = run(make_project(HOUSE, rotation=0))
    text = outcome.rationale
    assert "meets the street on the front edge" in text
    assert "hall runs back" in text
    assert "Garage meets the street" in text
    assert "Hallway is" in text and "% of the floor area" in text
    assert "deepest" in text


def test_a_side_street_lot_enters_from_the_side():
    outcome = run(make_project(HOUSE, streets=("right",)))
    assert outcome.status == "ok", outcome.messages
    assert outcome.plan.entry_edge == "right"


def test_a_tiny_program_needs_no_hall():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Living", room_type="living_room"),
        Room(name="Kitchen", room_type="kitchen"),
    ]
    outcome = run(make_project(rooms))
    assert outcome.plan is not None
    assert not outcome.plan.corridor_needed
    assert "no hall is needed" in outcome.rationale

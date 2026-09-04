"""Stations 03/04: the specification that crosses the seam."""

from src.models import Project, Room, Setbacks, Site, SiteEdge
from src.zoning_spec import (
    AdjacencyRequirement,
    ZoneAssignment,
    ZoningSpec,
    apart_pairs,
    default_spec,
    expand_program,
    expand_requirements,
    must_pairs,
    reconcile_spec,
)


def make_project(rooms):
    edges = [
        SiteEdge(position="front", adjacency="street"),
        SiteEdge(position="back", adjacency="neighbor"),
        SiteEdge(position="left", adjacency="neighbor"),
        SiteEdge(position="right", adjacency="neighbor"),
    ]
    return Project(site=Site(width_m=20.0, depth_m=28.0, edges=edges), setbacks=Setbacks(), rooms=rooms)


ROOMS = [
    Room(name="Entry", room_type="entry", is_entry=True),
    Room(name="Living", room_type="living_room"),
    Room(name="Dining", room_type="dining_room"),
    Room(name="Kitchen", room_type="kitchen"),
    Room(name="Primary", room_type="bedroom_primary"),
    Room(name="Bedroom", room_type="bedroom", count=2),
    Room(name="Bathroom", room_type="bathroom", count=2),
    Room(name="Garage", room_type="garage_double"),
]


def test_default_zones_come_from_the_access_table():
    spec = default_spec(make_project(ROOMS))
    zones = {a.room_name: a.zone for a in spec.assignments}
    assert zones["Living"] == "public"
    assert zones["Primary"] == "private"
    assert zones["Garage"] == "service"
    assert len(spec.assignments) == len(ROOMS)


def test_default_adjacencies_only_name_rooms_that_exist():
    spec = default_spec(make_project(ROOMS))
    names = {r.name for r in ROOMS}
    for adj in spec.adjacencies:
        assert adj.room_a in names and adj.room_b in names
    strengths = {(a.room_a, a.room_b): a.strength for a in spec.adjacencies}
    assert strengths[("Kitchen", "Dining")] == "must"
    assert strengths[("Primary", "Bathroom")] == "must"
    assert strengths[("Bedroom", "Garage")] == "apart"


def test_owner_hallways_are_not_placed_as_rooms():
    rooms = ROOMS + [Room(name="Hall", room_type="hallway")]
    instances, _ = expand_program(make_project(rooms), default_spec(make_project(rooms)))
    assert "Hall" not in [i.name for i in instances]


def test_counted_rooms_expand_into_numbered_instances():
    project = make_project(ROOMS)
    instances, notes = expand_program(project, default_spec(project))
    names = [i.name for i in instances]
    assert "Bedroom 1" in names and "Bedroom 2" in names and "Bedroom" not in names
    assert notes == []


def test_a_program_with_no_entry_gets_a_foyer_and_says_so():
    project = make_project([Room(name="Living", room_type="living_room")])
    instances, notes = expand_program(project, default_spec(project))
    assert [i.name for i in instances if i.is_entry] == ["Entry"]
    assert any("foyer was added" in n for n in notes)


def test_must_between_counted_rooms_pairs_instances_without_overloading_one():
    project = make_project(ROOMS)
    instances, _ = expand_program(project, default_spec(project))
    reqs = expand_requirements(default_spec(project), instances)
    musts = must_pairs(reqs)
    assert ("Primary", "Bathroom 1") in musts
    # The second bathroom is left free for the bedrooms.
    assert not any(pair[1] == "Bathroom 2" for pair in musts)


def test_should_applies_to_every_instance_against_any_instance():
    project = make_project(ROOMS)
    instances, _ = expand_program(project, default_spec(project))
    reqs = expand_requirements(default_spec(project), instances)
    bedroom_shoulds = [r for r in reqs if r.strength == "should" and r.room == "Bedroom 2"]
    assert any(set(r.options) == {"Bathroom 1", "Bathroom 2"} for r in bedroom_shoulds)


def test_apart_applies_to_every_pair():
    project = make_project(ROOMS)
    instances, _ = expand_program(project, default_spec(project))
    pairs = apart_pairs(expand_requirements(default_spec(project), instances))
    assert ("Bedroom 1", "Garage") in pairs and ("Bedroom 2", "Garage") in pairs


def test_reconcile_lets_the_proposal_win_and_drops_unknown_names():
    project = make_project(ROOMS)
    proposed = ZoningSpec(
        assignments=[ZoneAssignment(room_name="Living", zone="private"), ZoneAssignment(room_name="Sauna", zone="service")],
        adjacencies=[
            AdjacencyRequirement(room_a="Kitchen", room_b="Dining", strength="should"),
            AdjacencyRequirement(room_a="Kitchen", room_b="Pantry", strength="must"),
        ],
        rationale="Owner wants a quiet living room.",
    )
    spec, notes = reconcile_spec(project, proposed)
    assert spec.zone_for("Living") == "private"
    assert spec.zone_for("Kitchen") == "public"  # default fills the silence
    assert all(a.room_name != "Sauna" for a in spec.assignments)
    strengths = {frozenset((a.room_a, a.room_b)): a.strength for a in spec.adjacencies}
    assert strengths[frozenset(("Kitchen", "Dining"))] == "should"  # proposal overrides the default must
    assert frozenset(("Kitchen", "Pantry")) not in strengths
    assert strengths[frozenset(("Bedroom", "Garage"))] == "apart"  # default kept
    assert len(notes) == 2
    assert spec.rationale == "Owner wants a quiet living room."


def test_reconcile_with_nothing_proposed_is_the_default():
    project = make_project(ROOMS)
    spec, notes = reconcile_spec(project, None)
    assert spec == default_spec(project)
    assert notes == []

"""Choosing a layout, and the order the scoring cares about things in.

These tests pin down the priorities rather than the numbers: access beats
adjacency, adjacency beats circulation, and preferences never outrank the
brief's hard constraints. The weights can move; the ordering is the design.
"""

import pytest

from src.adjacency import AdjacencyGraph, AdjacencyRule
from src.geometry import compute_buildable_envelope
from src.layout_plan import CategoryLabels, LayoutPlan
from src.models import Project, Room, Setbacks, Site, SiteEdge
from src.place import candidate_structures, place_rooms
from src.planner import (
    CIRCULATION_TARGET_HIGH,
    CIRCULATION_TARGET_LOW,
    adjacency_satisfaction,
    best_layout,
    build_graph,
    circulation_ratio,
    score_layout,
)


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


def envelope_for(project):
    return compute_buildable_envelope(project.site, project.setbacks)


def plan_with(*rules):
    return LayoutPlan(
        grouping_label="Grouped by privacy level",
        category_labels=CategoryLabels(category_a="Private", category_b="Shared", category_c="Service"),
        assignments=[],
        adjacency=list(rules),
        rationale="test",
    )


HOUSE = [
    Room(name="Entry", room_type="entry", is_entry=True),
    Room(name="Living Room", room_type="living_room"),
    Room(name="Kitchen", room_type="kitchen"),
    Room(name="Primary Bedroom", room_type="bedroom_primary"),
    Room(name="Ensuite", room_type="bathroom"),
    Room(name="Bedroom", room_type="bedroom"),
    Room(name="Garage", room_type="garage_single"),
]


# --- the graph reaches the engine -----------------------------------------


def test_build_graph_expands_rules_to_room_instances():
    """A rule written about "Bedroom" has to reach "Bedroom 1"."""
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Bedroom", room_type="bedroom", count=2),
        Room(name="Bathroom", room_type="bathroom", count=2),
    ]
    project = make_project(20, 28, rooms)
    graph = build_graph(project, plan_with(
        AdjacencyRule(room_a="Bedroom", room_b="Bathroom", strength="must"),
    ))
    assert graph.strength("Bedroom 1", "Bathroom 1") == "must"


def test_no_plan_means_an_empty_graph_not_a_crash():
    project = make_project(20, 28, HOUSE)
    assert len(build_graph(project, None)) == 0
    assert best_layout(project, envelope_for(project)).result.rooms


# --- the priority ordering ------------------------------------------------


def test_a_met_must_scores_better_than_an_unmet_one():
    """The term the old pipeline could not have: with an ordering as input
    there was nothing to check a result against."""
    project = make_project(20, 28, HOUSE)
    envelope = envelope_for(project)
    result = place_rooms(project, envelope)

    asked = AdjacencyGraph(
        [room.name for room in result.rooms],
        [("Primary Bedroom", "Ensuite", "must")],
    )
    satisfied = adjacency_satisfaction(result, asked)
    met_score, *_ = score_layout(result, AdjacencyGraph([r.name for r in result.rooms]))
    asked_score, *_ = score_layout(result, asked)

    if satisfied.must_met:
        assert asked_score == pytest.approx(met_score)
    else:
        assert asked_score > met_score


def test_an_unmet_must_outweighs_any_number_of_preferences():
    project = make_project(20, 28, HOUSE)
    result = place_rooms(project, envelope_for(project))
    names = [room.name for room in result.rooms]

    far = ("Garage", "Ensuite")
    one_unmet = AdjacencyGraph(names, [(*far, "must")])
    many_unmet_should = AdjacencyGraph(names, [
        (*far, "should"),
        ("Garage", "Primary Bedroom", "should"),
        ("Garage", "Kitchen", "should"),
    ])
    if adjacency_satisfaction(result, one_unmet).must_met:
        pytest.skip("the engine satisfied the pair, so there is nothing to compare")

    assert score_layout(result, one_unmet)[0] > score_layout(result, many_unmet_should)[0]


def test_access_outranks_everything():
    """No amount of satisfied brief buys back a plan you cannot walk."""
    from src.planner import W_ACCESS, W_BROKEN_AVOID, W_UNMET_MUST
    assert W_ACCESS > W_UNMET_MUST > W_BROKEN_AVOID


def test_circulation_is_a_band_not_a_target_of_zero():
    """Driving hallway to zero leads back to rooms entered through other
    rooms, the very fault access forbids."""
    assert 0 < CIRCULATION_TARGET_LOW < CIRCULATION_TARGET_HIGH < 1


# --- the chosen layout ----------------------------------------------------


def test_best_layout_delivers_the_brief_it_was_given():
    project = make_project(20, 28, HOUSE)
    chosen = best_layout(project, envelope_for(project), plan_with(
        AdjacencyRule(room_a="Primary Bedroom", room_b="Ensuite", strength="must"),
        AdjacencyRule(room_a="Kitchen", room_b="Living Room", strength="must"),
        AdjacencyRule(room_a="Garage", room_b="Primary Bedroom", strength="avoid"),
    ))
    assert chosen.access_problems == 0
    assert chosen.adjacency.unmet_must == ()
    assert chosen.adjacency.violated_avoid == ()


def test_notes_report_what_was_delivered_not_just_that_it_ran():
    project = make_project(20, 28, HOUSE)
    chosen = best_layout(project, envelope_for(project), plan_with(
        AdjacencyRule(room_a="Primary Bedroom", room_b="Ensuite", strength="must"),
    ))
    assert "required adjacencies met" in chosen.notes
    assert chosen.structure is not None
    assert chosen.structure.label in chosen.notes


def test_best_layout_is_deterministic():
    project = make_project(20, 28, HOUSE)
    envelope = envelope_for(project)
    plan = plan_with(AdjacencyRule(room_a="Primary Bedroom", room_b="Ensuite", strength="must"))
    first = best_layout(project, envelope, plan)
    second = best_layout(project, envelope, plan)
    assert first.structure == second.structure
    assert first.score == second.score


def test_every_candidate_structure_is_considered():
    project = make_project(20, 28, HOUSE)
    chosen = best_layout(project, envelope_for(project))
    assert f"best of {len(candidate_structures())} arrangements" in chosen.notes


def test_an_undersized_plan_loses_to_a_buildable_one():
    """The score has no term for a room shrunk under its minimum, so those
    candidates are dropped before scoring rather than left to compete."""
    from src.place import respects_minimums
    project = make_project(14, 34, HOUSE)
    envelope = envelope_for(project)
    laid = [place_rooms(project, envelope, None, s) for s in candidate_structures()]
    if all(respects_minimums(result) for result in laid):
        pytest.skip("every structure fits this lot, so there is nothing to reject")
    assert respects_minimums(best_layout(project, envelope).result)


def test_circulation_ratio_is_corridor_over_built_area():
    project = make_project(20, 28, HOUSE)
    result = place_rooms(project, envelope_for(project))
    corridor = sum(c.width_m * c.depth_m for c in result.corridors)
    built = corridor + sum(r.width_m * r.depth_m for r in result.rooms)
    assert circulation_ratio(result) == pytest.approx(corridor / built)


def test_no_rooms_is_reported_not_crashed():
    project = make_project(20, 28, [])
    chosen = best_layout(project, envelope_for(project))
    assert chosen.result.rooms == []
    assert "no rooms" in chosen.notes

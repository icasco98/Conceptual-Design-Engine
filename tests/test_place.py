"""Placement against the adjacency graph.

The old packer could only be tested on geometry -- no overlaps, everything
inside the envelope -- because a room ordering gave nothing else to check.
These tests check the thing that actually matters: that a stated `must`
comes out as a shared wall, that a stated `avoid` does not, and that
neither costs the plan its walkability.
"""

import pytest

from src.access import access_problems_for
from src.adjacency import AdjacencyGraph, AdjacencyRule, touching_pairs
from src.geometry import compute_buildable_envelope
from src.models import Project, Room, Setbacks, Site, SiteEdge
from src.place import (
    SPINE_MIN_ROOMS,
    Structure,
    build_cells,
    candidate_structures,
    instances_by_base,
    place_rooms,
    respects_minimums,
)
from src.planner import best_layout, build_graph, room_rects

ALL_STRUCTURES = candidate_structures()


def make_project(width, depth, rooms, hallway=1.2) -> Project:
    return Project(
        site=Site(width_m=width, depth_m=depth, edges=[
            SiteEdge(position="front", adjacency="street"),
            SiteEdge(position="back", adjacency="neighbor"),
            SiteEdge(position="left", adjacency="neighbor"),
            SiteEdge(position="right", adjacency="neighbor"),
        ]),
        setbacks=Setbacks(),
        hallway_width_m=hallway,
        rooms=rooms,
    )


def envelope_for(project):
    return compute_buildable_envelope(project.site, project.setbacks)


HOUSE = [
    Room(name="Entry", room_type="entry", is_entry=True),
    Room(name="Living Room", room_type="living_room"),
    Room(name="Kitchen", room_type="kitchen"),
    Room(name="Primary Bedroom", room_type="bedroom_primary"),
    Room(name="Ensuite", room_type="bathroom"),
    Room(name="Bedroom", room_type="bedroom"),
    Room(name="Garage", room_type="garage_single"),
]


def graph_for(project, rules):
    names = [cell.name for cell in build_cells(project)]
    return AdjacencyGraph.from_rules(names, rules, instances_by_base(project))


def touching(result):
    return {frozenset(pair) for pair in touching_pairs(room_rects(result))}


def rect_of(box):
    return (box.x_m, box.y_m, box.x_m + box.width_m, box.y_m + box.depth_m)


def overlap_area(a, b):
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    return max(0.0, min(ax1, bx1) - max(ax0, bx0)) * max(0.0, min(ay1, by1) - max(ay0, by0))


# --- the whole point: the brief reaches the rectangles --------------------


def test_a_must_edge_becomes_a_shared_wall():
    """The failure this rebuild exists to fix. Under an ordering, an ensuite
    four names away from its bedroom could not be expressed at all."""
    project = make_project(20, 28, HOUSE)
    graph = graph_for(project, [
        AdjacencyRule(room_a="Primary Bedroom", room_b="Ensuite", strength="must"),
    ])
    result = place_rooms(project, envelope_for(project), graph)
    assert frozenset(("Primary Bedroom", "Ensuite")) in touching(result)


def test_several_must_edges_at_once():
    project = make_project(20, 28, HOUSE)
    rules = [
        AdjacencyRule(room_a="Primary Bedroom", room_b="Ensuite", strength="must"),
        AdjacencyRule(room_a="Kitchen", room_b="Living Room", strength="must"),
    ]
    graph = graph_for(project, rules)
    result = place_rooms(project, envelope_for(project), graph)
    walls = touching(result)
    assert frozenset(("Primary Bedroom", "Ensuite")) in walls
    assert frozenset(("Kitchen", "Living Room")) in walls


def test_a_chain_of_must_edges_stays_together():
    """Contracted must-edges are transitive: kitchen-dining-living is one
    unit, and no side assignment may split it."""
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Kitchen", room_type="kitchen"),
        Room(name="Dining", room_type="dining_room"),
        Room(name="Living Room", room_type="living_room"),
        Room(name="Bedroom", room_type="bedroom"),
        Room(name="Bathroom", room_type="bathroom"),
    ]
    project = make_project(20, 28, rooms)
    graph = graph_for(project, [
        AdjacencyRule(room_a="Kitchen", room_b="Dining", strength="must"),
        AdjacencyRule(room_a="Dining", room_b="Living Room", strength="must"),
    ])
    result = place_rooms(project, envelope_for(project), graph)
    walls = touching(result)
    assert frozenset(("Kitchen", "Dining")) in walls
    assert frozenset(("Dining", "Living Room")) in walls


def test_must_edges_survive_counted_rooms():
    """"Each bedroom has its own bathroom" pairs by index, and both pairs
    have to come out as real walls."""
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Living Room", room_type="living_room"),
        Room(name="Bedroom", room_type="bedroom", count=2),
        Room(name="Bathroom", room_type="bathroom", count=2),
    ]
    project = make_project(20, 28, rooms)
    graph = graph_for(project, [
        AdjacencyRule(room_a="Bedroom", room_b="Bathroom", strength="must"),
    ])
    result = place_rooms(project, envelope_for(project), graph)
    walls = touching(result)
    assert frozenset(("Bedroom 1", "Bathroom 1")) in walls
    assert frozenset(("Bedroom 2", "Bathroom 2")) in walls


def test_avoid_keeps_two_rooms_off_each_other():
    project = make_project(20, 28, HOUSE)
    graph = graph_for(project, [
        AdjacencyRule(room_a="Garage", room_b="Primary Bedroom", strength="avoid"),
        AdjacencyRule(room_a="Garage", room_b="Bedroom", strength="avoid"),
    ])
    chosen = best_layout(project, envelope_for(project),
                         _plan_with(graph_rules=[
                             AdjacencyRule(room_a="Garage", room_b="Primary Bedroom", strength="avoid"),
                             AdjacencyRule(room_a="Garage", room_b="Bedroom", strength="avoid"),
                         ]))
    assert chosen.adjacency.violated_avoid == ()


def _plan_with(graph_rules):
    from src.layout_plan import CategoryLabels, LayoutPlan
    return LayoutPlan(
        grouping_label="Grouped by privacy level",
        category_labels=CategoryLabels(category_a="Private", category_b="Shared", category_c="Service"),
        assignments=[],
        adjacency=graph_rules,
        rationale="test",
    )


def test_an_empty_graph_still_produces_a_plan():
    """Saying nothing is a legitimate brief and must not be a failure mode."""
    project = make_project(20, 28, HOUSE)
    result = place_rooms(project, envelope_for(project))
    assert len(result.rooms) == len(HOUSE)
    assert access_problems_for(result) == []


# --- access, still a hard constraint --------------------------------------


@pytest.mark.parametrize("structure", ALL_STRUCTURES)
def test_every_room_is_reachable(structure):
    project = make_project(20, 28, HOUSE)
    graph = graph_for(project, [
        AdjacencyRule(room_a="Primary Bedroom", room_b="Ensuite", strength="must"),
    ])
    result = place_rooms(project, envelope_for(project), graph, structure)
    assert access_problems_for(result) == []


def test_a_room_is_never_placed_behind_an_impassable_one():
    """The second rank exists so rooms can touch more than two neighbours.
    It is only legal where the room in front may be walked through -- a
    study behind a bedroom is not a plan."""
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Living Room", room_type="living_room"),
        Room(name="Bedroom", room_type="bedroom", count=3),
        Room(name="Bathroom", room_type="bathroom", count=2),
        Room(name="Garage", room_type="garage_double"),
    ]
    project = make_project(24, 32, rooms)
    graph = graph_for(project, [
        AdjacencyRule(room_a="Bedroom", room_b="Bathroom", strength="must"),
    ])
    for structure in ALL_STRUCTURES:
        result = place_rooms(project, envelope_for(project), graph, structure)
        assert access_problems_for(result) == [], structure.label


def test_the_garage_program_that_broke_the_old_packer():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Garage", room_type="garage_double"),
        Room(name="Bedroom", room_type="bedroom", count=3),
        Room(name="Bathroom", room_type="bathroom"),
        Room(name="Living Room", room_type="living_room"),
    ]
    project = make_project(22, 30, rooms)
    for structure in ALL_STRUCTURES:
        result = place_rooms(project, envelope_for(project), None, structure)
        assert access_problems_for(result) == [], structure.label


# --- geometry -------------------------------------------------------------


@pytest.mark.parametrize("structure", ALL_STRUCTURES)
def test_nothing_overlaps(structure):
    project = make_project(20, 28, HOUSE)
    result = place_rooms(project, envelope_for(project), None, structure)
    boxes = [rect_of(b) for b in list(result.rooms) + list(result.corridors)]
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            assert overlap_area(boxes[i], boxes[j]) < 1e-9


@pytest.mark.parametrize("structure", ALL_STRUCTURES)
def test_everything_stays_inside_the_envelope(structure):
    for width, depth in ((20, 28), (14, 34), (34, 14), (12, 18)):
        project = make_project(width, depth, HOUSE)
        envelope = envelope_for(project)
        result = place_rooms(project, envelope, None, structure)
        for box in list(result.rooms) + list(result.corridors):
            assert box.x_m >= envelope.left_setback_m - 1e-6
            assert box.y_m >= envelope.back_setback_m - 1e-6
            assert box.x_m + box.width_m <= envelope.left_setback_m + envelope.width_m + 1e-6
            assert box.y_m + box.depth_m <= envelope.back_setback_m + envelope.depth_m + 1e-6


@pytest.mark.parametrize("structure", ALL_STRUCTURES)
def test_rooms_keep_their_own_minimum_size(structure):
    project = make_project(20, 28, HOUSE)
    result = place_rooms(project, envelope_for(project), None, structure)
    assert respects_minimums(result)


def test_transposed_minimums_rotate_with_the_rectangle():
    """A cross spine turns every room a quarter turn; the minimums describe
    the rectangle as drawn, because the canvas resizes against them."""
    project = make_project(20, 28, HOUSE)
    result = place_rooms(project, envelope_for(project), None, Structure("width", "public"))
    garage = next(r for r in result.rooms if r.room_type == "garage_single")
    assert sorted((garage.min_width_m, garage.min_depth_m)) == [3.0, 6.0]


def test_counts_expand_and_hallway_rooms_are_dropped():
    rooms = HOUSE + [
        Room(name="Hallway", room_type="hallway"),
        Room(name="Bedroom", room_type="bedroom", count=2),
    ]
    project = make_project(24, 32, rooms)
    result = place_rooms(project, envelope_for(project))
    names = sorted(room.name for room in result.rooms)
    assert "Hallway" not in names
    assert "Bedroom 1" in names and "Bedroom 2" in names


def test_a_two_room_plan_gets_no_corridor():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Living Room", room_type="living_room"),
    ]
    assert len(rooms) < SPINE_MIN_ROOMS
    project = make_project(14, 16, rooms)
    assert place_rooms(project, envelope_for(project)).corridors == []


def test_empty_program_is_an_empty_layout():
    project = make_project(20, 28, [])
    result = place_rooms(project, envelope_for(project))
    assert result.rooms == [] and result.corridors == [] and result.footprint == []


def test_entry_sits_on_the_front_edge():
    project = make_project(20, 28, HOUSE)
    envelope = envelope_for(project)
    result = place_rooms(project, envelope)
    entry = next(room for room in result.rooms if room.is_entry)
    front = envelope.back_setback_m + envelope.depth_m
    assert entry.y_m + entry.depth_m == pytest.approx(front)


def test_deterministic():
    project = make_project(20, 28, HOUSE)
    envelope = envelope_for(project)
    graph = graph_for(project, [
        AdjacencyRule(room_a="Primary Bedroom", room_b="Ensuite", strength="must"),
    ])
    first = place_rooms(project, envelope, graph)
    second = place_rooms(project, envelope, graph)
    assert [rect_of(r) for r in first.rooms] == [rect_of(r) for r in second.rooms]

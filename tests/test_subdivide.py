"""Slicing the envelope rather than packing rows.

The row packer's guarantees are geometric: no overlaps, everything inside
the envelope. The slicing tree claims something stronger -- that access is
structural, because every room spans its side and therefore touches the
spine along its whole edge. These tests pin that claim down, since it is
the only reason to prefer this strategy.
"""

import pytest

from src.access import access_problems_for, rects_touch
from src.geometry import compute_buildable_envelope
from src.models import Project, Room, Setbacks, Site, SiteEdge
from src.planner import best_layout, circulation_ratio
from src.subdivide import (
    SPINE_MIN_ROOMS,
    Structure,
    candidate_structures,
    respects_minimums,
    subdivide_rooms,
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


HOUSE = [
    Room(name="Entry", room_type="entry", is_entry=True),
    Room(name="Living Room", room_type="living_room"),
    Room(name="Kitchen", room_type="kitchen"),
    Room(name="Bedroom", room_type="bedroom", count=2),
    Room(name="Bathroom", room_type="bathroom", count=2),
    Room(name="Garage", room_type="garage_single"),
]

# The arrangement the row packer exists to avoid: a bedroom that can only be
# reached through the garage. The slicing tree should not be able to produce
# it for any structure.
AWKWARD = [
    Room(name="Entry", room_type="entry", is_entry=True),
    Room(name="Garage", room_type="garage_double"),
    Room(name="Bedroom", room_type="bedroom", count=3),
    Room(name="Bathroom", room_type="bathroom"),
    Room(name="Living Room", room_type="living_room"),
]


def rect_of(box):
    return (box.x_m, box.y_m, box.x_m + box.width_m, box.y_m + box.depth_m)


def overlap_area(a, b):
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    return max(0.0, min(ax1, bx1) - max(ax0, bx0)) * max(0.0, min(ay1, by1) - max(ay0, by0))


def all_boxes(result):
    return list(result.rooms) + list(result.corridors)


# --- the structural claim -------------------------------------------------


@pytest.mark.parametrize("structure", candidate_structures())
def test_every_room_touches_the_spine(structure):
    """The whole point of the strategy: access by construction, for every
    structure, not just the one that happens to score best."""
    project = make_project(20, 28, HOUSE)
    result = subdivide_rooms(project, envelope_for(project), structure)

    assert len(result.corridors) == 1
    spine = rect_of(result.corridors[0])
    for room in result.rooms:
        assert rects_touch(rect_of(room), spine), f"{room.name} does not reach the corridor"


@pytest.mark.parametrize("structure", candidate_structures())
def test_no_access_problems_for_any_structure(structure):
    project = make_project(20, 28, HOUSE)
    result = subdivide_rooms(project, envelope_for(project), structure)
    assert access_problems_for(result) == []


@pytest.mark.parametrize("structure", candidate_structures())
def test_the_awkward_program_is_still_walkable(structure):
    """A garage-heavy program is what breaks the row packer. Slicing cannot
    route through the garage because nothing routes through anything."""
    project = make_project(22, 30, AWKWARD)
    result = subdivide_rooms(project, envelope_for(project), structure)
    assert access_problems_for(result) == []


# --- geometry -------------------------------------------------------------


@pytest.mark.parametrize("structure", candidate_structures())
def test_nothing_overlaps(structure):
    project = make_project(20, 28, HOUSE)
    result = subdivide_rooms(project, envelope_for(project), structure)
    boxes = [rect_of(b) for b in all_boxes(result)]
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            assert overlap_area(boxes[i], boxes[j]) < 1e-9


@pytest.mark.parametrize("structure", candidate_structures())
def test_everything_stays_inside_the_envelope(structure):
    project = make_project(20, 28, HOUSE)
    envelope = envelope_for(project)
    result = subdivide_rooms(project, envelope, structure)

    x0 = envelope.left_setback_m
    y0 = envelope.back_setback_m
    for box in all_boxes(result):
        assert box.x_m >= x0 - 1e-6
        assert box.y_m >= y0 - 1e-6
        assert box.x_m + box.width_m <= x0 + envelope.width_m + 1e-6
        assert box.y_m + box.depth_m <= y0 + envelope.depth_m + 1e-6


@pytest.mark.parametrize("structure", candidate_structures())
def test_no_room_goes_below_its_own_minimum(structure):
    """Padding a short side stretches rooms past nominal; it must never
    squeeze one under the minimum src.defaults gives its type."""
    project = make_project(20, 28, HOUSE)
    result = subdivide_rooms(project, envelope_for(project), structure)
    assert respects_minimums(result)
    for room in result.rooms:
        assert room.width_m >= room.min_width_m - 1e-6, room.name
        assert room.depth_m >= room.min_depth_m - 1e-6, room.name


@pytest.mark.parametrize("structure", candidate_structures())
def test_transposed_minimums_rotate_with_the_rectangle(structure):
    """A cross spine turns every room a quarter turn. The minimums describe
    the rectangle as drawn -- the canvas resizes against them in site
    coordinates -- so they have to turn with it."""
    project = make_project(20, 28, HOUSE)
    result = subdivide_rooms(project, envelope_for(project), structure)

    garage = next(r for r in result.rooms if r.room_type == "garage_single")
    # 3.0 x 6.0 unrotated; the pair is the same whichever way it is drawn.
    assert sorted((garage.min_width_m, garage.min_depth_m)) == [3.0, 6.0]


def test_a_program_that_does_not_fit_is_flagged_not_hidden():
    """The last-resort scale-down can take rooms under their minimum. That
    has to be detectable, because score_layout has no term for it."""
    project = make_project(8, 10, [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Living Room", room_type="living_room"),
        Room(name="Bedroom", room_type="bedroom", count=3),
        Room(name="Garage", room_type="garage_double"),
    ])
    result = subdivide_rooms(project, envelope_for(project))
    assert not respects_minimums(result)


def test_planner_prefers_a_structure_that_respects_minimums():
    """On a lot much deeper than it is wide, the cross-spine structures only
    fit by shrinking rooms. The planner must not pick one of those just
    because its circulation happens to score well."""
    project = make_project(14, 34, HOUSE)
    envelope = envelope_for(project)

    all_structures = [subdivide_rooms(project, envelope, s) for s in candidate_structures()]
    assert not all(respects_minimums(r) for r in all_structures), "no undersized candidate to reject"

    chosen = best_layout(project, envelope, strategy="subdivide")
    assert respects_minimums(chosen.result)


def test_room_counts_are_expanded_and_hallways_dropped():
    """Two bedrooms and two bathrooms become four boxes; a hallway in the
    program is a signal, not a box -- the spine is the circulation."""
    rooms = HOUSE + [Room(name="Hallway", room_type="hallway")]
    project = make_project(20, 28, rooms)
    result = subdivide_rooms(project, envelope_for(project))

    names = sorted(room.name for room in result.rooms)
    assert names == sorted([
        "Entry", "Living Room", "Kitchen",
        "Bedroom 1", "Bedroom 2", "Bathroom 1", "Bathroom 2", "Garage",
    ])


def test_footprint_is_the_building_not_the_envelope():
    """A program smaller than the lot gets a building smaller than the lot,
    rather than one stretched to fill it."""
    project = make_project(30, 40, HOUSE)
    envelope = envelope_for(project)
    result = subdivide_rooms(project, envelope)

    xs = [x for x, _ in result.footprint]
    ys = [y for _, y in result.footprint]
    assert len(result.footprint) == 4
    assert (max(xs) - min(xs)) < envelope.width_m
    assert (max(ys) - min(ys)) < envelope.depth_m


# --- placement rules ------------------------------------------------------


def test_entry_sits_on_the_front_edge():
    project = make_project(20, 28, HOUSE)
    envelope = envelope_for(project)
    result = subdivide_rooms(project, envelope)

    entry = next(room for room in result.rooms if room.is_entry)
    front_line = envelope.back_setback_m + envelope.depth_m
    assert entry.y_m + entry.depth_m == pytest.approx(front_line)


@pytest.mark.parametrize("structure", candidate_structures())
def test_garage_reaches_the_street_edge(structure):
    """A garage served from inside the house is a garage in the wrong
    place, whatever the zone order asks for. It sits flush with the front
    of the building -- which does not stop another side of the plan from
    reaching the front too, as it does when the bedrooms get their own
    flank."""
    project = make_project(22, 30, AWKWARD)
    envelope = envelope_for(project)
    result = subdivide_rooms(project, envelope, structure)

    garage = next(room for room in result.rooms if room.room_type == "garage_double")
    front_line = max(room.y_m + room.depth_m for room in result.rooms)
    assert garage.y_m + garage.depth_m == pytest.approx(front_line), structure.label


def test_private_rooms_sit_deeper_than_public_ones():
    project = make_project(20, 28, HOUSE)
    envelope = envelope_for(project)
    result = subdivide_rooms(project, envelope, Structure("depth", ("public", "service", "private"), "balance"))

    front = envelope.back_setback_m + envelope.depth_m
    depth_of = {r.name: front - (r.y_m + r.depth_m) for r in result.rooms}
    living = depth_of["Living Room"]
    assert min(depth_of["Bedroom 1"], depth_of["Bedroom 2"]) > living


def test_a_two_room_plan_gets_no_corridor():
    """Below SPINE_MIN_ROOMS a corridor is not circulation, just floor
    area -- the plan is entered and walked directly."""
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Living Room", room_type="living_room"),
    ]
    assert len(rooms) < SPINE_MIN_ROOMS
    project = make_project(14, 16, rooms)
    result = subdivide_rooms(project, envelope_for(project))
    assert result.corridors == []


def test_circulation_lands_in_a_plausible_band():
    project = make_project(20, 28, HOUSE)
    result = subdivide_rooms(project, envelope_for(project))
    assert 0.03 < circulation_ratio(result) < 0.20


def test_deterministic():
    project = make_project(20, 28, HOUSE)
    envelope = envelope_for(project)
    first = subdivide_rooms(project, envelope)
    second = subdivide_rooms(project, envelope)
    assert [rect_of(r) for r in first.rooms] == [rect_of(r) for r in second.rooms]


def test_empty_program_is_an_empty_layout():
    project = make_project(20, 28, [])
    result = subdivide_rooms(project, envelope_for(project))
    assert result.rooms == [] and result.corridors == [] and result.footprint == []


# --- planner integration --------------------------------------------------


def test_planner_can_choose_the_strategy():
    project = make_project(20, 28, HOUSE)
    envelope = envelope_for(project)

    rows = best_layout(project, envelope, strategy="rows")
    sliced = best_layout(project, envelope, strategy="subdivide")

    assert rows.strategy == "rows" and rows.structure is None
    assert sliced.strategy == "subdivide" and sliced.structure is not None
    assert sliced.access_problems == 0


def test_default_strategy_is_unchanged():
    """The switch exists so the two can be compared, not so the default
    moves silently."""
    project = make_project(20, 28, HOUSE)
    envelope = envelope_for(project)
    assert best_layout(project, envelope).strategy == "rows"


def test_unknown_strategy_is_rejected():
    project = make_project(20, 28, HOUSE)
    with pytest.raises(ValueError):
        best_layout(project, envelope_for(project), strategy="pinwheel")

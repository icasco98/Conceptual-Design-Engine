"""Choosing a layout rather than accepting the first one.

The packer is good at geometry and has no opinion about architecture. These
tests pin the opinions down: access is a hard constraint, circulation is a
cost, and a corridor has to earn its floor area.
"""

from src.access import access_problems_for
from src.geometry import compute_buildable_envelope
from src.layout import pack_rooms
from src.models import Project, Room, Setbacks, Site, SiteEdge
from src.planner import (
    CIRCULATION_TARGET_HIGH,
    CIRCULATION_TARGET_LOW,
    best_layout,
    circulation_ratio,
    score_layout,
    thin_corridors,
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


SMALL = [
    Room(name="Entry", room_type="entry", is_entry=True),
    Room(name="Living Room", room_type="living_room"),
    Room(name="Bedroom", room_type="bedroom"),
    Room(name="Bathroom", room_type="bathroom"),
]

WIDE = [
    Room(name="Entry", room_type="entry", is_entry=True),
    Room(name="Living Room", room_type="living_room"),
    Room(name="Kitchen", room_type="kitchen"),
    Room(name="Bedroom", room_type="bedroom", count=2),
    Room(name="Bathroom", room_type="bathroom", count=2),
    Room(name="Garage", room_type="garage_single"),
]

DEEP = [
    Room(name="Entry", room_type="entry", is_entry=True),
    Room(name="Living Room", room_type="living_room"),
    Room(name="Kitchen", room_type="kitchen"),
    Room(name="Bedroom", room_type="bedroom", count=3),
    Room(name="Bathroom", room_type="bathroom", count=2),
    Room(name="Storage", room_type="storage"),
]


def test_every_room_is_reachable_without_walking_through_another():
    """The whole point. Across plot shapes that previously produced plans
    where a bedroom was only reachable through a bathroom or the garage."""
    for width, depth, rooms in ((20, 28, WIDE), (12, 34, DEEP), (30, 14, WIDE), (10, 12, SMALL)):
        project = make_project(width, depth, rooms)
        chosen = best_layout(project, envelope_for(project))
        assert chosen.access_problems == 0, (
            f"{width}x{depth}: " + "; ".join(p.message for p in access_problems_for(chosen.result))
        )


def test_a_single_row_plan_gets_a_corridor_built_for_it():
    """A plan that packs into one row has no gaps between rows, so under the
    old model it got no circulation at all and every room was reachable only
    through its neighbours. A corridor is added past the last row instead."""
    project = make_project(30, 14, WIDE)
    envelope = envelope_for(project)

    naive = pack_rooms(project, envelope)
    assert naive.corridors == []
    assert access_problems_for(naive)

    chosen = best_layout(project, envelope)
    assert chosen.result.corridors
    assert chosen.access_problems == 0


def test_a_corridor_nothing_needs_is_removed():
    """Circulation is a cost. If access survives without a corridor, that
    corridor was floor area spent on nothing."""
    project = make_project(10, 12, SMALL)
    envelope = envelope_for(project)

    with_all, _ = thin_corridors(project, envelope, [r.name for r in SMALL])
    chosen = best_layout(project, envelope)

    assert chosen.access_problems == 0
    # Whatever is left, every corridor is load-bearing: the thinning pass
    # already tried removing each one and kept only the removals that cost
    # nothing in access.
    assert len(chosen.result.corridors) <= len(with_all.corridors)


def test_thinning_never_trades_away_access_to_save_corridor():
    for width, depth, rooms in ((20, 28, WIDE), (12, 34, DEEP)):
        project = make_project(width, depth, rooms)
        envelope = envelope_for(project)
        order = [r.name for r in rooms]
        full = pack_rooms(project, envelope, order, [True] * 8)
        thinned, _ = thin_corridors(project, envelope, order)
        assert len(access_problems_for(thinned)) <= len(access_problems_for(full))


def test_corridors_are_linked_into_one_network():
    """A corridor between two rows touches only those two rows. Three or
    more rows leaves them as separate strips, and a row of rooms you can't
    walk through cuts off everything past the first one -- so a spine runs
    down the side to join them."""
    project = make_project(12, 34, DEEP)
    envelope = envelope_for(project)
    result = pack_rooms(project, envelope)

    assert len(result.corridors) >= 3
    verticals = [c for c in result.corridors if c.depth_m > c.width_m]
    assert verticals, "a plan with several corridors needs one linking them"
    assert access_problems_for(result) == []


def test_the_entry_reaches_both_the_street_and_the_circulation():
    """A foyer runs the full depth of its row: front door on the street
    edge, circulation on the other side."""
    project = make_project(20, 28, WIDE)
    envelope = envelope_for(project)
    result = pack_rooms(project, envelope)

    entry = next(r for r in result.rooms if r.is_entry)
    street_edge = envelope.back_setback_m + envelope.depth_m
    assert abs((entry.y_m + entry.depth_m) - street_edge) < 0.01


def test_access_dominates_the_score():
    """No arrangement of rectangles is worth a plan you can't walk through,
    so one access problem must outweigh any circulation or shape saving."""
    project = make_project(30, 14, WIDE)
    envelope = envelope_for(project)

    broken = pack_rooms(project, envelope)          # one row, no corridor
    good = best_layout(project, envelope).result

    broken_score, broken_problems, broken_ratio = score_layout(broken)
    good_score, good_problems, _ = score_layout(good)

    assert broken_problems > 0 and good_problems == 0
    assert broken_ratio == 0.0          # the "cheapest" possible circulation
    assert good_score < broken_score    # ...and still the worse plan


def test_circulation_is_scored_as_a_band_not_minimised():
    """Driving circulation to zero recreates the fault access forbids, so
    the score prefers the band a house normally spends rather than the
    smallest number."""
    project = make_project(20, 28, WIDE)
    chosen = best_layout(project, envelope_for(project))
    assert 0.0 < chosen.circulation_ratio < 0.30
    assert CIRCULATION_TARGET_LOW < CIRCULATION_TARGET_HIGH


def test_the_choice_is_deterministic():
    project = make_project(20, 28, WIDE)
    envelope = envelope_for(project)
    first = best_layout(project, envelope)
    second = best_layout(project, envelope)
    assert first.placement_order == second.placement_order
    assert first.score == second.score


def test_circulation_ratio_is_corridor_share_of_built_area():
    project = make_project(20, 28, WIDE)
    result = best_layout(project, envelope_for(project)).result
    corridor_area = sum(c.width_m * c.depth_m for c in result.corridors)
    room_area = sum(r.width_m * r.depth_m for r in result.rooms)
    assert abs(circulation_ratio(result) - corridor_area / (corridor_area + room_area)) < 1e-9

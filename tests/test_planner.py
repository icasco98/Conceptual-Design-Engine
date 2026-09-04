"""Choosing a layout rather than accepting the first one.

The packer is good at geometry and has no opinion about architecture. These
tests pin the opinions down: access is a hard constraint, circulation is a
cost, and a corridor has to earn its floor area.
"""

from src.access import access_problems_for
from src.geometry import compute_buildable_envelope
from src.layout import pack_levels, pack_rooms
from src.layout_plan import Adjacency, CategoryLabels, LayoutPlan, RoomAssignment
from src.models import Project, Room, Setbacks, Site, SiteEdge
from src.planner import (
    CIRCULATION_TARGET_HIGH,
    CIRCULATION_TARGET_LOW,
    _cluster_by_adjacency,
    adjacency_penalty,
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


# --------------------------------------------------------------- adjacency


def near(a, b, strength="mild"):
    return Adjacency(room_a=a, room_b=b, relation="near", strength=strength)


def apart(a, b, strength="mild"):
    return Adjacency(room_a=a, room_b=b, relation="apart", strength=strength)


PAIR_ROOMS = [
    Room(name="Entry", room_type="entry", is_entry=True),
    Room(name="Kitchen", room_type="kitchen"),
    Room(name="Dining", room_type="dining_room"),
    Room(name="Garage", room_type="garage_single"),
]


def packed(order):
    project = make_project(24, 30, PAIR_ROOMS)
    return pack_levels(project, envelope_for(project), order)


def test_a_pairing_the_plan_honours_costs_less_than_one_it_ignores():
    """The whole point: the same rooms, ordered two ways, and the scorer can
    tell which arrangement did what was asked."""
    together = packed(["Entry", "Kitchen", "Dining", "Garage"])
    apart_plan = packed(["Entry", "Kitchen", "Garage", "Dining"])
    pairs = [near("Kitchen", "Dining", "strong")]
    assert adjacency_penalty(together, pairs) < adjacency_penalty(apart_plan, pairs)


def test_no_pairings_is_no_penalty():
    assert adjacency_penalty(packed(["Entry", "Kitchen", "Dining", "Garage"]), []) == 0.0


def test_a_pairing_naming_a_room_that_was_never_placed_is_ignored():
    """Claude names rooms from the program; a typo or a room the packer
    dropped must not quietly score as a violation."""
    result = packed(["Entry", "Kitchen", "Dining", "Garage"])
    assert adjacency_penalty(result, [near("Kitchen", "Ballroom")]) == 0.0
    assert adjacency_penalty(result, [near("Kitchen", "Kitchen")]) == 0.0


def test_keeping_rooms_apart_is_satisfied_by_distance():
    """`apart` stops pulling once the rooms are far enough apart, so the
    scorer cannot wreck a plan chasing another metre of separation."""
    result = packed(["Entry", "Kitchen", "Dining", "Garage"])
    close = adjacency_penalty(packed(["Entry", "Kitchen", "Garage", "Dining"]), [apart("Kitchen", "Garage")])
    far = adjacency_penalty(result, [apart("Entry", "Garage")])
    assert far <= close


def test_strong_pairings_outweigh_mild_ones():
    ignored = packed(["Entry", "Kitchen", "Garage", "Dining"])
    mild = adjacency_penalty(ignored, [near("Kitchen", "Dining", "mild")])
    strong = adjacency_penalty(ignored, [near("Kitchen", "Dining", "strong")])
    assert strong > mild


def test_rooms_on_different_storeys_are_as_far_apart_as_the_plan_allows():
    """Two rooms asked to be near each other on different floors are not
    near each other, whatever their plan coordinates happen to say."""
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True, levels=[0]),
        Room(name="Kitchen", room_type="kitchen", levels=[0]),
        Room(name="Study", room_type="office", levels=[1]),
        Room(name="Stair", room_type="stair", levels=[0, 1]),
    ]
    project = make_project(24, 30, rooms)
    project.storeys = 2
    multi = pack_levels(project, envelope_for(project), ["Entry", "Kitchen", "Stair", "Study"])
    assert adjacency_penalty(multi, [near("Kitchen", "Study", "strong")]) > 0
    # ...and the stair alone is enough separation for a pairing that wanted it.
    assert adjacency_penalty(multi, [apart("Kitchen", "Study")]) == 0.0


def test_adjacency_never_outweighs_a_room_you_cannot_reach():
    """Access is the hard constraint. The worst possible adjacency score
    must still cost less than a single unreachable room."""
    result = packed(["Entry", "Kitchen", "Garage", "Dining"])
    worst = [near("Kitchen", "Garage", "strong"), near("Entry", "Dining", "strong")]
    plain, _, _ = score_layout(result)
    with_pairs, _, _ = score_layout(result, worst)
    assert with_pairs - plain < 100.0


def test_clustering_keeps_every_room_exactly_once():
    order = ["Entry", "Garage", "Kitchen", "Bedroom", "Dining"]
    pairs = [near("Kitchen", "Dining", "strong"), near("Bedroom", "Entry")]
    out = _cluster_by_adjacency(order, pairs)
    assert sorted(out) == sorted(order)
    assert len(out) == len(order)


def test_clustering_puts_paired_rooms_side_by_side():
    order = ["Entry", "Garage", "Kitchen", "Bedroom", "Dining"]
    out = _cluster_by_adjacency(order, [near("Kitchen", "Dining", "strong")])
    assert abs(out.index("Kitchen") - out.index("Dining")) == 1


def pair_plan(adjacencies):
    return LayoutPlan(
        grouping_label="Grouped by function",
        category_labels=CategoryLabels(category_a="Private", category_b="Shared", category_c="Service"),
        assignments=[RoomAssignment(room_name=r.name, category="category_b") for r in PAIR_ROOMS],
        placement_order=["Entry", "Kitchen", "Garage", "Dining"],
        adjacencies=adjacencies,
        rationale="Kitchen and dining belong together.",
    )


def test_the_planner_offers_an_arrangement_built_from_the_pairings():
    """best_layout can only choose among the arrangements it generates, so
    a pairing has to reach candidate generation, not just scoring.

    Asserted on where the rooms end up rather than on where their names sit
    in the ordering. Those were the same thing while rows were the only way
    to pack a plan; with a second strategy they are not, and the ordering
    was only ever a proxy for the thing actually wanted.
    """
    project = make_project(24, 30, PAIR_ROOMS)
    envelope = envelope_for(project)
    wanted = [near("Kitchen", "Dining", "strong")]

    ignored = best_layout(project, envelope, pair_plan([]))
    honoured = best_layout(project, envelope, pair_plan(wanted))

    assert adjacency_penalty(honoured.result, wanted) < adjacency_penalty(ignored.result, wanted)


def test_a_strong_pairing_actually_changes_which_layout_is_chosen():
    """The weight has to be big enough to matter, not just present.

    Scoring a pairing correctly is worthless if the term is too small to
    ever outvote the tool's own preferences. At the first weight tried, the
    arrangement that honoured a strong pairing lost to one that ignored it
    by a couple of points of compactness -- correct arithmetic, no effect.
    """
    from src.sample_project import sample_layout_plan, sample_project

    project = sample_project()
    plan = sample_layout_plan()
    envelope = envelope_for(project)
    wanted = [near("Double Garage", "Kitchen", "strong")]

    without = best_layout(project, envelope, plan)
    with_pair = best_layout(project, envelope, plan.model_copy(update={"adjacencies": wanted}))

    assert adjacency_penalty(with_pair.result, wanted) < adjacency_penalty(without.result, wanted)


def test_a_stated_preference_never_outweighs_a_room_you_cannot_reach():
    """Sun is a preference; access is a constraint. The worst possible
    orientation score must still cost less than one unreachable room."""
    from src.layout_plan import RoomAspect

    project = make_project(24, 30, PAIR_ROOMS)
    project.site.rotation_deg = 0
    result = packed(["Entry", "Kitchen", "Garage", "Dining"])
    worst = [
        RoomAspect(room_name=name, wants="morning_sun") for name in ("Entry", "Kitchen", "Garage", "Dining")
    ]
    plain, _, _ = score_layout(result)
    with_wishes, _, _ = score_layout(result, [], project, worst)
    assert with_wishes - plain < 100.0


def test_the_site_bearing_changes_which_layout_is_chosen():
    """The whole point of reading rotation_deg: the same house on the same
    plot, turned around, should not get the same answer."""
    from src.layout_plan import RoomAspect

    plan_with_wish = LayoutPlan(
        grouping_label="Grouped by function",
        category_labels=CategoryLabels(category_a="Private", category_b="Shared", category_c="Service"),
        assignments=[RoomAssignment(room_name=r.name, category="category_b") for r in PAIR_ROOMS],
        placement_order=["Entry", "Kitchen", "Garage", "Dining"],
        orientations=[RoomAspect(room_name="Kitchen", wants="morning_sun")],
        rationale="The kitchen should catch the morning.",
    )

    def chosen(rotation):
        project = make_project(24, 30, PAIR_ROOMS)
        project.site.rotation_deg = rotation
        return best_layout(project, envelope_for(project), plan_with_wish).placement_order

    assert chosen(0) != chosen(180)

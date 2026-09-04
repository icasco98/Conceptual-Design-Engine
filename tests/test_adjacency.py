"""The contract between Claude and the geometry.

These tests are about one thing: that a stated relationship survives the
trip from the brief to the rectangles, and that a brief which cannot be
built says so instead of failing mysteriously later.
"""

import pytest

from src.adjacency import (
    STRENGTH_WEIGHT,
    AdjacencyGraph,
    AdjacencyRule,
    expand_rule_names,
    touching_pairs,
)

ROOMS = ["Entry", "Living Room", "Kitchen", "Primary Bedroom", "Ensuite", "Garage"]


def graph(*rules):
    return AdjacencyGraph(ROOMS, rules)


# --- normalisation --------------------------------------------------------


def test_pairs_are_unordered():
    g = graph(("Kitchen", "Living Room", "must"))
    assert g.strength("Living Room", "Kitchen") == "must"
    assert g.pairs("must") == [("Kitchen", "Living Room")]


def test_a_pair_stated_twice_keeps_the_stronger_reading():
    """A stray `should` must never quietly downgrade a `must` -- whichever
    order the model happened to emit them in."""
    assert graph(("Kitchen", "Living Room", "must"),
                 ("Living Room", "Kitchen", "should")).strength("Kitchen", "Living Room") == "must"
    assert graph(("Kitchen", "Living Room", "should"),
                 ("Living Room", "Kitchen", "must")).strength("Kitchen", "Living Room") == "must"


def test_nonsense_rules_are_dropped_not_raised():
    """The model writes these. A hallucinated room name or a room paired
    with itself should cost nothing -- the rest of the brief still stands."""
    g = graph(
        ("Kitchen", "Kitchen", "must"),
        ("Kitchen", "Wine Cellar", "must"),
        ("Kitchen", "Living Room", "sort-of"),
        ("Kitchen", "Entry", "should"),
    )
    assert len(g) == 1
    assert g.strength("Kitchen", "Entry") == "should"


def test_avoid_pulls_the_other_way():
    g = graph(("Garage", "Primary Bedroom", "avoid"))
    assert g.weight("Garage", "Primary Bedroom") < 0
    assert STRENGTH_WEIGHT["must"] > STRENGTH_WEIGHT["should"] > 0


def test_unstated_pairs_weigh_nothing():
    assert graph().weight("Kitchen", "Garage") == 0.0


# --- counted rooms --------------------------------------------------------


def test_must_over_counted_rooms_pairs_by_index():
    """"Each bedroom has its own bathroom" is a pairing, not a demand that
    every bedroom touch every bathroom -- which no plan could satisfy."""
    rule = AdjacencyRule(room_a="Bedroom", room_b="Bathroom", strength="must")
    pairs = expand_rule_names(rule, {
        "Bedroom": ["Bedroom 1", "Bedroom 2"],
        "Bathroom": ["Bathroom 1", "Bathroom 2"],
    })
    assert sorted(pairs) == [("Bedroom 1", "Bathroom 1"), ("Bedroom 2", "Bathroom 2")]


def test_should_over_counted_rooms_spreads_across_every_instance():
    rule = AdjacencyRule(room_a="Bedroom", room_b="Bathroom", strength="should")
    pairs = expand_rule_names(rule, {
        "Bedroom": ["Bedroom 1", "Bedroom 2"],
        "Bathroom": ["Bathroom 1", "Bathroom 2"],
    })
    assert len(pairs) == 4


def test_a_single_room_reaches_every_instance_of_a_counted_one():
    rule = AdjacencyRule(room_a="Hall", room_b="Bedroom", strength="must")
    pairs = expand_rule_names(rule, {"Hall": ["Hall"], "Bedroom": ["Bedroom 1", "Bedroom 2"]})
    assert sorted(pairs) == [("Hall", "Bedroom 1"), ("Hall", "Bedroom 2")]


# --- clusters -------------------------------------------------------------


def test_must_edges_contract_into_one_cluster():
    """Rooms that must touch move as a unit, so a later placement decision
    cannot split a pair that was never allowed to split."""
    g = graph(("Primary Bedroom", "Ensuite", "must"), ("Kitchen", "Living Room", "must"))
    clusters = [sorted(c) for c in g.clusters()]
    assert sorted(clusters) == sorted([
        ["Entry"], ["Ensuite", "Primary Bedroom"], ["Kitchen", "Living Room"], ["Garage"],
    ])


def test_must_edges_chain_transitively():
    g = graph(("Entry", "Living Room", "must"), ("Living Room", "Kitchen", "must"))
    biggest = max(g.clusters(), key=len)
    assert sorted(biggest) == ["Entry", "Kitchen", "Living Room"]


def test_should_edges_do_not_cluster():
    """A preference is not a constraint; it must not fuse two rooms into an
    unbreakable unit."""
    g = graph(("Kitchen", "Living Room", "should"))
    assert all(len(c) == 1 for c in g.clusters())


def test_clustering_is_deterministic():
    g = graph(("Primary Bedroom", "Ensuite", "must"))
    assert g.clusters() == g.clusters()


# --- feasibility ----------------------------------------------------------


def test_a_satisfiable_brief_has_no_problems():
    g = graph(("Kitchen", "Living Room", "must"), ("Primary Bedroom", "Ensuite", "must"))
    assert g.feasibility_problems() == []


def test_five_mutually_adjacent_rooms_are_rejected_before_any_geometry():
    """A rectangular plan is the rectangular dual of its adjacency graph,
    and a rectangular dual only exists for a planar graph. Five rooms all
    touching is a plausible request and an impossible one."""
    five = ROOMS[:5]
    rules = [(a, b, "must") for i, a in enumerate(five) for b in five[i + 1:]]
    problems = AdjacencyGraph(ROOMS, rules).feasibility_problems()

    assert len(problems) == 1
    assert "No rectangular plan" in problems[0]
    for name in five:
        assert name in problems[0], "the message has to name the rooms to drop"


def test_four_mutually_adjacent_rooms_are_allowed():
    """3v-6 for v=4 is 6, which is exactly K4 -- the bound must not reject
    a brief that is buildable."""
    four = ROOMS[:4]
    rules = [(a, b, "must") for i, a in enumerate(four) for b in four[i + 1:]]
    assert AdjacencyGraph(ROOMS, rules).feasibility_problems() == []


def test_only_must_edges_constrain_feasibility():
    """Preferences are not promises; over-stating them can never make a
    brief unbuildable."""
    five = ROOMS[:5]
    rules = [(a, b, "should") for i, a in enumerate(five) for b in five[i + 1:]]
    assert AdjacencyGraph(ROOMS, rules).feasibility_problems() == []


# --- measuring a result ---------------------------------------------------


def test_touching_pairs_needs_a_shared_wall_not_a_corner():
    """You cannot put a door on a point."""
    side_by_side = {"A": (0, 0, 2, 2), "B": (2, 0, 4, 2)}
    corner_only = {"A": (0, 0, 2, 2), "B": (2, 2, 4, 4)}
    assert touching_pairs(side_by_side) == [("A", "B")]
    assert touching_pairs(corner_only) == []


def test_satisfaction_reports_what_was_delivered():
    g = graph(
        ("Kitchen", "Living Room", "must"),
        ("Primary Bedroom", "Ensuite", "must"),
        ("Entry", "Living Room", "should"),
        ("Garage", "Primary Bedroom", "avoid"),
    )
    report = g.satisfaction([
        ("Kitchen", "Living Room"),
        ("Garage", "Primary Bedroom"),
    ])

    assert report.must_met == 1 and report.must_total == 2
    assert report.unmet_must == (("Ensuite", "Primary Bedroom"),)
    assert report.should_met == 0
    assert report.violated_avoid == (("Garage", "Primary Bedroom"),)


def test_an_empty_brief_is_fully_satisfied():
    """Saying nothing is a legitimate answer, and must not read as failure
    -- it leaves the engine free to optimise for everything else."""
    report = graph().satisfaction([])
    assert report.must_ratio == 1.0 and report.should_ratio == 1.0
    assert report.summary() == "no adjacencies requested"

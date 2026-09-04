"""Station 05: some briefs cannot be built, and it is proved before packing."""

from itertools import combinations

from src.feasibility import check_feasibility


def test_a_chain_of_musts_is_feasible():
    report = check_feasibility([("Kitchen", "Dining"), ("Dining", "Living")])
    assert report.feasible and report.problems == []


def test_five_mutually_adjacent_rooms_have_no_plan():
    pairs = list(combinations(["A", "B", "C", "D", "E"], 2))
    report = check_feasibility(pairs)
    assert not report.feasible
    assert any("no rectangular plan exists" in p for p in report.problems)
    assert report.offending


def test_k33_is_caught():
    pairs = [(a, b) for a in "ABC" for b in "XYZ"]
    report = check_feasibility(pairs)
    assert not report.feasible
    assert any("cannot be drawn without crossings" in p for p in report.problems)


def test_a_room_required_to_touch_three_others_names_them():
    report = check_feasibility([("Kitchen", "Dining"), ("Kitchen", "Living"), ("Kitchen", "Garage")])
    assert not report.feasible
    assert "Kitchen is required to share a wall with Dining, Garage and Living" in report.problems[0]
    assert report.offending == [("Kitchen", "Living")]


def test_a_ring_of_musts_is_refused():
    report = check_feasibility([("A", "B"), ("B", "C"), ("C", "A")])
    assert not report.feasible
    assert any("ring" in p for p in report.problems)


def test_must_and_apart_on_the_same_pair_is_a_contradiction():
    report = check_feasibility([("Bedroom", "Garage")], apart=[("Bedroom", "Garage")])
    assert not report.feasible
    assert "both to share a wall and to be kept apart" in report.problems[0]
    assert report.offending == [("Bedroom", "Garage")]


def test_no_musts_is_trivially_feasible():
    assert check_feasibility([]).feasible

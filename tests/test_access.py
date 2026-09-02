"""The access rules, and the check that holds a layout to them.

The packer's own guarantee is geometric -- no overlaps, everything inside
the envelope. Whether you can actually walk from the street to a bedroom
without passing through the garage is a separate question, and this is what
asks it.
"""

from src.access import (
    AccessProblem,
    Node,
    access_for,
    find_access_problems,
    is_passable,
    rects_touch,
    zone_of,
)


def test_destinations_are_never_passable():
    """The rooms a plan must not route through: you don't walk through
    somebody's bedroom, a bathroom or the car to get somewhere else."""
    for room_type in ("bedroom", "bedroom_primary", "bathroom", "garage_single",
                      "garage_double", "storage", "closet", "laundry"):
        assert not is_passable(room_type), room_type


def test_circulation_rooms_are_passable():
    for room_type in ("entry", "hallway", "living_room", "family_room",
                      "dining_room", "mudroom"):
        assert is_passable(room_type), room_type


def test_zones_follow_the_public_to_private_gradient():
    assert zone_of("entry") == "public"
    assert zone_of("living_room") == "public"
    assert zone_of("bedroom_primary") == "private"
    assert zone_of("bathroom") == "private"
    assert zone_of("garage_double") == "service"


def test_a_garage_meets_the_street_not_the_corridor():
    assert access_for("garage_double").street_access
    assert not access_for("kitchen").street_access


def test_rects_touching_at_only_a_corner_do_not_count():
    """You can't hang a door on a point."""
    a = (0.0, 0.0, 2.0, 2.0)
    corner = (2.0, 2.0, 4.0, 4.0)
    edge = (2.0, 0.0, 4.0, 2.0)
    assert not rects_touch(a, corner)
    assert rects_touch(a, edge)


def _n(name, x0, y0, x1, y1, passable, entry=False, street=False):
    return Node(name, (x0, y0, x1, y1), passable, entry, street)


def test_a_room_reached_only_through_the_garage_is_reported_with_the_culprit():
    """The exact fault seen in a real run: street -> garage -> bedroom."""
    nodes = [
        _n("Entry", 0, 0, 2, 2, True, entry=True),
        _n("Garage", 2, 0, 8, 2, False),
        _n("Bedroom", 8, 0, 12, 2, False),
    ]
    problems = find_access_problems(nodes)

    assert [p.room_name for p in problems] == ["Bedroom"]
    assert problems[0].kind == "through_room"
    assert "Garage" in problems[0].via
    assert "through Garage" in problems[0].message


def test_the_same_rooms_are_fine_once_a_corridor_serves_them():
    """Nothing about the rooms changed -- only whether circulation reaches
    them. That is the whole point of the check."""
    nodes = [
        _n("Entry", 0, 0, 2, 2, True, entry=True),
        _n("Hallway", 2, 0, 12, 2, True),
        _n("Garage", 2, 2, 8, 8, False),
        _n("Bedroom", 8, 2, 12, 8, False),
    ]
    assert find_access_problems(nodes) == []


def test_a_room_touching_nothing_is_reported_as_unreachable():
    nodes = [
        _n("Entry", 0, 0, 2, 2, True, entry=True),
        _n("Bedroom", 20, 20, 24, 24, False),
    ]
    problems = find_access_problems(nodes)
    assert problems == [AccessProblem("Bedroom", "unreachable")]
    assert "can't be reached" in problems[0].message


def test_a_garage_off_the_circulation_is_not_a_fault():
    """It meets the street directly -- being off the household's circulation
    is what a garage is supposed to do."""
    nodes = [
        _n("Entry", 0, 0, 2, 2, True, entry=True),
        _n("Garage", 20, 20, 26, 26, False, street=True),
    ]
    assert find_access_problems(nodes) == []


def test_a_plan_with_no_entry_is_not_judged():
    """Intake may not have captured an entry yet; that is validation's
    complaint to make, not this module's."""
    nodes = [_n("Bedroom", 0, 0, 4, 4, False)]
    assert find_access_problems(nodes) == []


def test_passable_rooms_can_be_routed_through():
    """A living room is a legitimate route; a bedroom in the same position
    would not be."""
    chain = [
        _n("Entry", 0, 0, 2, 2, True, entry=True),
        _n("Living Room", 2, 0, 8, 2, True),
        _n("Bedroom", 8, 0, 12, 2, False),
    ]
    assert find_access_problems(chain) == []

    chain[1] = _n("Bedroom 1", 2, 0, 8, 2, False)
    assert [p.room_name for p in find_access_problems(chain)] == ["Bedroom"]

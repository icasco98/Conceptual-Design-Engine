"""Graph geometry: touching, depth, outline."""

from src.access import Node
from src.circulation import justified_depths, rect_gap, touching_edge, union_outline, polygon_area


def test_touching_edge_reports_the_shared_wall_and_its_axis():
    axis, mid = touching_edge((0, 0, 4, 3), (4, 1, 7, 5))
    assert axis == "x" and mid == (4, 2)
    axis, mid = touching_edge((0, 0, 4, 3), (1, 3, 3, 6))
    assert axis == "y" and mid == (2, 3)
    assert touching_edge((0, 0, 1, 1), (1, 1, 2, 2)) is None  # corner only


def test_rect_gap_is_zero_when_touching_and_the_distance_otherwise():
    assert rect_gap((0, 0, 1, 1), (1, 0, 2, 1)) == 0.0
    assert rect_gap((0, 0, 1, 1), (4, 0, 5, 1)) == 3.0
    assert abs(rect_gap((0, 0, 1, 1), (4, 5, 5, 6)) - 5.0) < 1e-9


def _n(name, x0, y0, x1, y1, passable, entry=False):
    return Node(name, (x0, y0, x1, y1), passable, entry)


def test_justified_depth_counts_doors_through_passable_rooms_only():
    nodes = [
        _n("Entry", 0, 0, 2, 2, True, entry=True),
        _n("Hall", 0, 2, 2, 8, True),
        _n("Bed 1", 2, 2, 5, 5, False),
        _n("Bed 2", 2, 5, 5, 8, False),
        _n("Closet", 5, 2, 6, 5, False),  # only reachable through Bed 1
    ]
    depths = justified_depths(nodes)
    assert depths == {"Entry": 0, "Hall": 1, "Bed 1": 2, "Bed 2": 2, "Closet": None}


def test_union_outline_traces_the_building_not_its_bounding_box():
    outline = union_outline([(0, 0, 4, 3), (4, 0, 6, 5), (0, 3, 2, 4)])
    assert polygon_area(outline) == 24.0
    assert set(outline) == {(0, 0), (6, 0), (6, 5), (4, 5), (4, 3), (2, 3), (2, 4), (0, 4)}


def test_union_outline_of_one_rectangle_is_that_rectangle():
    assert union_outline([(1, 1, 3, 4)]) == [(1, 1), (3, 1), (3, 4), (1, 4)]


def test_union_outline_returns_the_largest_piece_when_disjoint():
    outline = union_outline([(0, 0, 1, 1), (5, 5, 9, 9)])
    assert polygon_area(outline) == 16.0

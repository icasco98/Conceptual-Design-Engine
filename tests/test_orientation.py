"""Which way a room faces, and whether that is what was asked for.

`site.rotation_deg` and `project.priorities` were both recorded and read by
nothing. These tests pin down what reading them means: intent in, direction
out, hemisphere never assumed.
"""

import pytest

from src.geometry import compute_buildable_envelope
from src.layout import pack_rooms
from src.layout_plan import RoomAspect
from src.models import Project, Room, Setbacks, Site, SiteEdge
from src.orientation import EAST, WEST, aspect_penalty, direction_for, street_penalty
from src.planner import orientation_penalty


def make_project(rotation=None, street_edges=("front",)) -> Project:
    return Project(
        site=Site(
            width_m=24,
            depth_m=30,
            rotation_deg=rotation,
            edges=[
                SiteEdge(position=p, adjacency="street" if p in street_edges else "neighbor")
                for p in ("front", "back", "left", "right")
            ],
        ),
        setbacks=Setbacks(),
        rooms=[
            Room(name="Entry", room_type="entry", is_entry=True),
            Room(name="Kitchen", room_type="kitchen"),
            Room(name="Study", room_type="office"),
            Room(name="Garage", room_type="garage_single"),
        ],
    )


def packed(project):
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    return pack_rooms(project, envelope, ["Entry", "Kitchen", "Study", "Garage"])


@pytest.mark.parametrize(
    "rotation,expected",
    [(0, (1, 0)), (90, (0, 1)), (180, (-1, 0)), (270, (0, -1))],
)
def test_east_lands_where_the_site_bearing_puts_it(rotation, expected):
    """The front edge's bearing is the whole input. With the front facing
    north, east is to the right of the plan; turn the site and east turns
    with it."""
    dx, dy = direction_for(rotation, EAST)
    assert round(dx) == expected[0]
    assert round(dy) == expected[1]


def test_an_unstated_bearing_is_treated_as_front_facing_north():
    assert direction_for(None, EAST) == direction_for(0, EAST)


def test_east_and_west_are_opposites():
    ex, ey = direction_for(35, EAST)
    wx, wy = direction_for(35, WEST)
    assert ex == pytest.approx(-wx, abs=1e-9)
    assert ey == pytest.approx(-wy, abs=1e-9)


def test_a_room_at_the_sunny_end_scores_zero_and_the_far_end_scores_one():
    result = packed(make_project(rotation=0))
    east = direction_for(0, EAST)
    scores = {r.name: aspect_penalty(result, r.name, east) for r in result.rooms}
    assert min(scores.values()) == pytest.approx(0.0)
    assert max(scores.values()) == pytest.approx(1.0)


def test_turning_the_site_around_inverts_the_wish():
    """The same arrangement, the same request, the opposite site bearing:
    what was ideally placed is now as wrong as it can be."""
    project = make_project(rotation=0)
    result = packed(project)
    wish = [RoomAspect(room_name="Kitchen", wants="morning_sun")]
    from src.layout import MultiLevelLayout

    multi = MultiLevelLayout(levels=[result])
    facing_north = orientation_penalty(multi, project, wish)

    turned = make_project(rotation=180)
    assert orientation_penalty(multi, turned, wish) == pytest.approx(1.0 - facing_north)


def test_a_room_nobody_asked_about_costs_nothing():
    from src.layout import MultiLevelLayout

    project = make_project(rotation=0)
    multi = MultiLevelLayout(levels=[packed(project)])
    assert orientation_penalty(multi, project, []) == 0.0
    assert orientation_penalty(multi, project, [RoomAspect(room_name="Ballroom", wants="morning_sun")]) == 0.0


def test_off_the_street_prefers_the_far_side_of_the_plot():
    project = make_project(street_edges=("front",))
    result = packed(project)
    scores = {r.name: street_penalty(result, r.name, project.site) for r in result.rooms}
    assert min(scores.values()) == pytest.approx(0.0)
    assert max(scores.values()) > 0.0


def test_a_corner_plot_counts_the_worst_of_both_roads():
    """Tucked away from one road while sitting on another is not what
    anybody meant by 'off the street'."""
    one_road = make_project(street_edges=("front",))
    corner = make_project(street_edges=("front", "left"))
    result = packed(one_road)
    for room in result.rooms:
        assert street_penalty(result, room.name, corner.site) >= street_penalty(
            result, room.name, one_road.site
        )


def test_a_site_with_no_street_edge_cannot_fail_the_wish():
    project = make_project(street_edges=())
    result = packed(project)
    assert street_penalty(result, "Kitchen", project.site) == 0.0

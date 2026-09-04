"""Station 02: the site is read before any room is placed."""

from src.models import Project, Room, Setbacks, Site, SiteEdge
from src.site_analysis import analyse_site


def make_project(rotation=None, hemisphere="north", streets=("front",)):
    edges = [
        SiteEdge(position=p, adjacency="street" if p in streets else "neighbor")
        for p in ("front", "back", "left", "right")
    ]
    site = Site(width_m=20.0, depth_m=28.0, rotation_deg=rotation, hemisphere=hemisphere, edges=edges)
    return Project(site=site, setbacks=Setbacks(), rooms=[Room(name="Entry", room_type="entry", is_entry=True)])


def test_the_entry_edge_is_the_street_edge():
    assert analyse_site(make_project()).entry_edge == "front"
    assert analyse_site(make_project(streets=("left",))).entry_edge == "left"
    # A corner lot with the front on the street keeps the front door there.
    assert analyse_site(make_project(streets=("front", "right"))).entry_edge == "front"


def test_unknown_orientation_favours_no_edge_for_sun_and_says_so():
    analysis = analyse_site(make_project())
    assert not analysis.orientation_known
    assert analysis.sun_edge is None
    assert all(r.sun == 0.0 for r in analysis.edges.values())
    assert any("hasn't been described" in n for n in analysis.notes)


def test_a_north_facing_plot_gets_its_sun_on_the_back_edge():
    analysis = analyse_site(make_project(rotation=0))
    assert analysis.sun_edge == "back"
    assert analysis.poor_edge == "front"
    assert analysis.edges["right"].bearing_deg == 90.0
    assert analysis.edges["right"].morning > 0.99


def test_a_south_facing_plot_gets_its_sun_on_the_street_edge():
    analysis = analyse_site(make_project(rotation=180))
    assert analysis.sun_edge == "front"


def test_the_southern_hemisphere_inverts_the_sunny_side():
    assert analyse_site(make_project(rotation=0, hemisphere="south")).sun_edge == "front"


def test_preferences_follow_the_sheet():
    analysis = analyse_site(make_project(rotation=0))
    prefs = analysis.preferences
    # Public rooms want the sunny back edge more than the poor front edge.
    assert prefs["public"]["back"] > prefs["public"]["front"]
    # Private rooms avoid the street.
    assert prefs["private"]["front"] < 0
    assert prefs["private"]["back"] > prefs["private"]["front"]
    # Service rooms take the street and the poor aspect.
    assert prefs["service"]["front"] > prefs["service"]["back"]


def test_notes_name_the_sunny_edge_when_known():
    analysis = analyse_site(make_project(rotation=0))
    assert any("back edge gets the sun" in n for n in analysis.notes)

import pytest

from src.geometry import IncompleteSiteError, compute_buildable_envelope
from src.models import Setbacks, Site, SiteEdge


def make_site(width=20.0, depth=30.0, **edge_adjacency) -> Site:
    defaults = {"front": "street", "back": "neighbor", "left": "neighbor", "right": "neighbor"}
    defaults.update(edge_adjacency)
    edges = [SiteEdge(position=pos, adjacency=adj) for pos, adj in defaults.items()]
    return Site(width_m=width, depth_m=depth, edges=edges)


def test_buildable_envelope_applies_default_setbacks():
    site = make_site(width=20.0, depth=30.0)
    envelope = compute_buildable_envelope(site, Setbacks(street_m=2.0, neighbor_m=1.5))

    assert envelope.front_setback_m == 2.0
    assert envelope.back_setback_m == 1.5
    assert envelope.left_setback_m == 1.5
    assert envelope.right_setback_m == 1.5
    assert envelope.width_m == pytest.approx(20.0 - 1.5 - 1.5)
    assert envelope.depth_m == pytest.approx(30.0 - 2.0 - 1.5)
    assert envelope.is_valid


def test_corner_lot_two_street_edges():
    site = make_site(width=15.0, depth=15.0, front="street", left="street")
    envelope = compute_buildable_envelope(site, Setbacks(street_m=2.0, neighbor_m=1.5))

    assert envelope.front_setback_m == 2.0
    assert envelope.left_setback_m == 2.0
    assert envelope.back_setback_m == 1.5
    assert envelope.right_setback_m == 1.5


def test_edge_override_wins_over_default():
    edges = [
        SiteEdge(position="front", adjacency="street", setback_override_m=3.5),
        SiteEdge(position="back", adjacency="neighbor"),
        SiteEdge(position="left", adjacency="neighbor"),
        SiteEdge(position="right", adjacency="neighbor"),
    ]
    site = Site(width_m=20.0, depth_m=30.0, edges=edges)
    envelope = compute_buildable_envelope(site, Setbacks(street_m=2.0, neighbor_m=1.5))

    assert envelope.front_setback_m == 3.5


def test_small_site_yields_invalid_envelope():
    site = make_site(width=3.0, depth=3.0)
    envelope = compute_buildable_envelope(site, Setbacks(street_m=2.0, neighbor_m=1.5))

    assert not envelope.is_valid
    assert envelope.area_m2 == 0.0


def test_incomplete_site_raises():
    site = Site(width_m=20.0, depth_m=30.0)  # no edges tagged
    with pytest.raises(IncompleteSiteError):
        compute_buildable_envelope(site, Setbacks())

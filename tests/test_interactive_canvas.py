from src.geometry import compute_buildable_envelope
from src.interactive_canvas import canvas_size_px, render_canvas_html
from src.layout import pack_rooms
from src.models import Project, Room, Setbacks, Site, SiteEdge


def make_project(width=18.0, depth=25.0, rooms=None) -> Project:
    edges = [
        SiteEdge(position="front", adjacency="street"),
        SiteEdge(position="back", adjacency="neighbor"),
        SiteEdge(position="left", adjacency="neighbor"),
        SiteEdge(position="right", adjacency="neighbor"),
    ]
    site = Site(width_m=width, depth_m=depth, edges=edges)
    return Project(site=site, setbacks=Setbacks(), rooms=rooms or [])


def _render(rooms, assignments=None):
    project = make_project(rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope)
    return render_canvas_html(project, envelope, result, assignments or {}), result


def test_every_room_appears_exactly_once_as_a_draggable_box():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Kitchen", room_type="kitchen"),
        Room(name="Bedroom", room_type="bedroom", count=2),
    ]
    html, result = _render(rooms)

    assert html.count('class="room-box') == len(result.rooms) == 4
    for room in result.rooms:
        assert f'>{room.name}<' in html or f">{room.name}</span>" in html


def test_entry_room_gets_the_entry_css_class():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Kitchen", room_type="kitchen"),
    ]
    html, _ = _render(rooms)

    assert 'class="room-box entry"' in html
    assert html.count('class="room-box entry"') == 1


def test_corridors_render_when_present_none_when_not():
    single_row = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html_no_corridor, result_no_corridor = _render(single_row)
    assert not result_no_corridor.corridors
    assert 'class="corridor"' not in html_no_corridor

    multi_row = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Bedroom", room_type="bedroom_primary", count=4),
    ]
    project = make_project(width=6.0, depth=40.0, rooms=multi_row)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope)
    html = render_canvas_html(project, envelope, result, {})
    assert result.corridors
    assert html.count('class="corridor"') == len(result.corridors)


def test_html_is_escaped_against_untrusted_room_names():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name='<img src=x onerror=alert(1)>', room_type="other"),
    ]
    html, _ = _render(rooms)

    assert "<img src=x" not in html
    assert "&lt;img" in html


def test_reset_button_and_drag_script_are_present():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert 'id="reset-btn"' in html
    assert "dataset.initialLeft" in html
    assert "addEventListener('mousedown'" in html


def test_canvas_size_matches_site_proportions():
    project = make_project(width=18.0, depth=25.0)
    width_px, height_px = canvas_size_px(project.site)

    # Wider than tall in roughly the same 18:25 ratio (plus fixed margins),
    # not some unrelated fixed size.
    assert width_px < height_px
    assert 400 < width_px < 700
    assert 700 < height_px < 900

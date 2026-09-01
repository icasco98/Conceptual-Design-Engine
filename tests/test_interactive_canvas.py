from src.geometry import compute_buildable_envelope
from src.interactive_canvas import canvas_size_px, render_canvas_html
from src.layout import pack_rooms
from src.layout_plan import CategoryLabels, LayoutPlan
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


def make_layout_plan(rooms) -> LayoutPlan:
    return LayoutPlan(
        grouping_label="Grouped by privacy level",
        category_labels=CategoryLabels(category_a="Private", category_b="Shared", category_c="Service"),
        assignments=[],
        placement_order=[r.name for r in rooms],
        rationale="Private rooms sit away from the entry; shared rooms cluster near it.",
    )


def _render(rooms, assignments=None):
    project = make_project(rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope)
    layout_plan = make_layout_plan(rooms)
    return render_canvas_html(project, envelope, result, assignments or {}, layout_plan), result


def test_every_room_appears_exactly_once_as_a_draggable_box():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Kitchen", room_type="kitchen"),
        Room(name="Bedroom", room_type="bedroom", count=2),
    ]
    html, result = _render(rooms)

    assert html.count('class="room-box draggable') == len(result.rooms) == 4
    for room in result.rooms:
        assert f'>{room.name}<' in html or f">{room.name}</span>" in html


def test_entry_room_gets_the_entry_css_class():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Kitchen", room_type="kitchen"),
    ]
    html, _ = _render(rooms)

    assert 'class="room-box draggable entry"' in html
    assert html.count('class="room-box draggable entry"') == 1


def test_corridors_render_when_present_none_when_not():
    single_row = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html_no_corridor, result_no_corridor = _render(single_row)
    assert not result_no_corridor.corridors
    assert 'class="corridor' not in html_no_corridor

    multi_row = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Bedroom", room_type="bedroom_primary", count=4),
    ]
    project = make_project(width=6.0, depth=40.0, rooms=multi_row)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope)
    html = render_canvas_html(project, envelope, result, {}, make_layout_plan(multi_row))
    assert result.corridors
    assert html.count('class="corridor draggable"') == len(result.corridors)


def test_corridors_are_draggable_like_rooms_not_fixed():
    import re

    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Bedroom", room_type="bedroom_primary", count=4),
    ]
    project = make_project(width=6.0, depth=40.0, rooms=rooms)
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope)
    html = render_canvas_html(project, envelope, result, {}, make_layout_plan(rooms))
    assert result.corridors

    # Corridors carry the same reset-position data attributes as rooms,
    # and share the .draggable class the event listeners attach to. (The
    # legend also says "Hallway" once, for the swatch — not counted here.)
    assert html.count('corridor-label">Hallway') == len(result.corridors)
    corridor_divs = re.findall(r'<div class="corridor draggable"[^>]*>', html)
    assert len(corridor_divs) == len(result.corridors)
    for div in corridor_divs:
        assert "data-initial-left=" in div
        assert "data-initial-top=" in div


def test_building_footprint_outline_is_drawn():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Kitchen", room_type="kitchen"),
    ]
    html, result = _render(rooms)

    assert result.footprint
    assert '<path id="footprint-shape" d="M ' in html


def test_footprint_recomputes_live_as_boxes_move():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    # No fixed shape baked in at drag time — the outline is recomputed from
    # wherever the boxes currently are, on load and after every move/reset.
    assert "function computeFootprintPath" in html
    assert "function updateFootprint" in html
    assert html.count("updateFootprint();") >= 3  # onMove, reset handler, initial call


def test_setback_envelope_bounds_and_room_minimums_are_exposed_to_js():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert 'data-env-left="' in html
    assert 'data-env-top="' in html
    assert 'data-env-right="' in html
    assert 'data-env-bottom="' in html
    assert "ENV.left" in html and "ENV.right" in html
    assert 'data-min-width="' in html
    assert 'data-min-height="' in html
    assert "clampToEnvelope" in html


def test_collision_resolution_script_is_present():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "function resolveOverlaps" in html
    assert "resolveOverlaps(active)" in html


def test_title_legend_and_rationale_are_rendered():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "Grouped by privacy level" in html
    assert "Private" in html and "Shared" in html and "Service" in html
    assert "Private rooms sit away from the entry" in html
    assert html.count('class="legend-item"') == 6  # 3 categories + Hallway + Entry + Door


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
    assert "dataset.initialWidth" in html  # reset restores size, not just position
    assert "addEventListener('mousedown'" in html


def test_grid_checkbox_and_snap_to_grid_are_present():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert 'id="grid-toggle"' in html
    assert 'type="checkbox"' in html
    assert 'id="grid-overlay"' in html
    assert "gridOverlay.style.display" in html  # checkbox actually toggles the overlay
    assert "function snapToGrid" in html
    assert "GRID_PX = 6.5" in html  # 0.25m grid at PX_PER_METER=26.0, snapping is unconditional


def test_door_arrows_reuse_circulation_edges_with_arrowhead_marker():
    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Kitchen", room_type="kitchen"),
    ]
    html, result = _render(rooms)

    assert result.circulation_edges
    assert '<marker id="door-arrow"' in html
    assert html.count('marker-end="url(#door-arrow)"') == len(result.circulation_edges)


def test_resize_handles_present_on_every_box():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, result = _render(rooms)

    total_boxes = len(result.rooms) + len(result.corridors)
    assert html.count('class="resize-handle nw" data-corner="nw"') == total_boxes
    assert html.count('class="resize-handle ne" data-corner="ne"') == total_boxes
    assert html.count('class="resize-handle sw" data-corner="sw"') == total_boxes
    assert html.count('class="resize-handle se" data-corner="se"') == total_boxes
    assert "function doResize" in html
    assert "function onResizeDown" in html


def test_rotate_handle_present_and_snaps_in_5_degree_steps():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, result = _render(rooms)

    total_boxes = len(result.rooms) + len(result.corridors)
    assert html.count('class="rotate-handle"') == total_boxes
    assert "function doRotate" in html
    assert "Math.round(angle / 5) * 5" in html


def test_delete_handle_present_and_hides_rather_than_removes():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, result = _render(rooms)

    total_boxes = len(result.rooms) + len(result.corridors)
    assert html.count('class="delete-handle"') == total_boxes
    assert "function onDeleteDown" in html
    assert "classList.add('deleted')" in html  # hidden via CSS, not removed from the DOM
    assert "function activeBoxes" in html  # deleted boxes excluded from collision/footprint


def test_reset_restores_rotation_and_deleted_state():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "dataset.rotation = '0'" in html
    assert "dataset.deleted = '0'" in html
    assert "classList.remove('deleted')" in html


def test_canvas_size_matches_site_proportions():
    project = make_project(width=18.0, depth=25.0)
    width_px, height_px = canvas_size_px(project.site)

    # Wider than tall in roughly the same 18:25 ratio (plus fixed margins),
    # not some unrelated fixed size.
    assert width_px < height_px
    assert 400 < width_px < 700
    assert 700 < height_px < 900

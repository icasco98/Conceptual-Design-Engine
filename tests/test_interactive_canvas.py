from src.geometry import compute_buildable_envelope
from src.interactive_canvas import SCHEDULE_MIN_WIDTH_PX, canvas_size_px, render_canvas_html
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
    # wherever the boxes currently are, on load and after every move/resize/
    # rotate/delete/reset, via refreshDiagram (footprint + door arrows).
    assert "function computeFootprintPath" in html
    assert "function updateFootprint" in html
    assert "function refreshDiagram" in html
    assert html.count("refreshDiagram();") >= 6  # onMove, doResize, doRotate, delete, reset, initial call


def test_door_arrows_recompute_live_from_whichever_boxes_are_touching():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    # Re-walks the touching-graph from the entry every time, instead of
    # staying fixed to the initial recommendation — so arrows stop pointing
    # at walls that no longer exist once rooms have been dragged apart.
    assert "function computeDoorArrowSegments" in html
    assert "function touchingEdge" in html
    assert "function updateDoorArrows" in html
    assert "classList.contains('entry')" in html


def test_door_arrows_are_always_axis_aligned_perpendicular_to_the_shared_wall():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    # perpendicularArrow only ever varies ONE coordinate between its two
    # endpoints (my is reused unchanged for a horizontal arrow, mx for a
    # vertical one) -- that's what guarantees every door arrow is strictly
    # horizontal or vertical, never a diagonal line to a room's center,
    # regardless of where the rooms currently are.
    assert "function perpendicularArrow" in html
    assert "[mx + fromSign * DOOR_INSET_PX, my], [mx - fromSign * DOOR_INSET_PX, my]" in html
    assert "[mx, my + fromSignY * DOOR_INSET_PX], [mx, my - fromSignY * DOOR_INSET_PX]" in html


def test_pinned_box_is_pushed_clear_as_a_last_resort_never_left_overlapping():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    # The overlap invariant's real guarantee: if a neighbor has already
    # shrunk to its own minimum and hit the envelope wall with nowhere
    # left to go, the box under the owner's cursor gets nudged (position
    # only) to clear it too, instead of visibly overlapping.
    assert "function pushPinnedClearOfOverlaps" in html
    assert "function shrinkAndPushNonPinned" in html
    assert "pushPinnedClearOfOverlaps(pinned)" in html
    # Even the gentler shrink-then-push heuristic can fail to converge in
    # a crowded scene (several boxes pushed toward the same small area) --
    # this unconditional both-sides separator is what actually guarantees
    # zero overlap in every scene, not just the common ones.
    assert "function forceSeparateAnyRemainingOverlaps" in html
    assert "forceSeparateAnyRemainingOverlaps()" in html


def test_rotation_inflates_the_effective_rect_used_for_collision_and_footprint():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    # Rotating a box does push its neighbors and does grow the footprint --
    # resolveOverlaps reads the rotated bounding box (effectiveRectOf) for
    # push magnitude, and computeFootprintPath reads the box's true
    # rotated shape (obbOf/pointInObb) for its coverage test.
    assert "function effectiveRectOf" in html
    assert "effectiveRectOf(a), rb = effectiveRectOf(b)" in html
    assert "function obbOf" in html
    assert "function pointInObb" in html
    assert "pointInObb(cx, cy, obbs[k])" in html


def test_rotated_boxes_can_actually_touch_not_just_get_close():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    # AABB-only overlap detection would stop two rotated rooms well short
    # of actually touching (a rotated square's bounding box is bigger than
    # the square). boxesReallyOverlap gates every collision-resolution
    # function on the true oriented-box SAT test instead, so rotated rooms
    # can be pushed together until their real edges meet.
    assert "function obbsSeparated" in html
    assert "function boxesReallyOverlap" in html
    assert html.count("boxesReallyOverlap(") >= 4  # 3 definitions/call-sites minimum + its own body


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
    # Delta-based (not absolute-angle) snapping: rotation changes by a
    # 5-degree-snapped amount relative to where the gesture started, so a
    # box that already had rotation keeps it as a baseline instead of
    # jumping to match the cursor's raw angle.
    assert "Math.round((angle - rot.startAngle) / 5) * 5" in html
    assert "rot.startRotations[i] + delta" in html


def test_multi_select_rotates_and_deletes_the_whole_selection_together():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "function selectBox" in html
    assert "selectBox(box, e.shiftKey)" in html
    assert "selected.length > 1" in html
    assert "targets.map(rotationOf)" in html  # group rotate: each box keeps its own starting rotation
    assert "function deleteBoxes" in html


def test_handles_hidden_until_selected():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    # Hidden and non-interactive by default; only a `.selected` (rotate/
    # delete) or `.solo-selected` (resize too) box reveals them -- no more
    # always-on hover reveal.
    assert ".resize-handle, .rotate-handle, .delete-handle {" in html
    assert "opacity: 0;" in html
    assert "pointer-events: none;" in html
    assert ".draggable.solo-selected .resize-handle" in html
    assert ".draggable.selected .rotate-handle" in html
    assert "function updateSelectionClasses" in html
    assert ":hover .resize-handle" not in html
    assert ":hover .rotate-handle" not in html


def test_room_schedule_lists_editable_dimensions_and_stays_synced():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, result = _render(rooms)

    assert 'id="schedule-table"' in html
    assert 'id="schedule-body"' in html
    assert "Width (m)" in html and "Depth (m)" in html
    assert "function renderSchedule" in html
    assert "function applyScheduleEdit" in html
    # Folded into refreshDiagram so it never goes stale after a move/
    # resize/rotate/delete/reset -- same wiring the footprint/door arrows use.
    assert "renderSchedule();" in html
    assert "updateFootprint();" in html.split("function refreshDiagram")[1][:200]


def test_room_schedule_sits_in_a_column_left_of_the_diagram():
    """The schedule is the app's only room table and reads as a panel beside
    the drawing, not a second table under it -- app.py sizes the Streamlit
    component from the canvas height alone, so anything stacked below the
    canvas would be cut off."""
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    body = html.split("<body>")[1]
    schedule_at = body.index('id="schedule-section"')
    canvas_at = body.index('id="canvas-container"')
    assert schedule_at < canvas_at, "schedule must come first in source order to land on the left"
    assert body.index('id="canvas-layout"') < schedule_at
    # nowrap on purpose: wrapping would push the diagram below the fixed
    # component height instead of just narrowing the panel.
    assert "flex-wrap: nowrap;" in html
    assert f"min-width: {SCHEDULE_MIN_WIDTH_PX}px;" in html


def test_gap_closing_snaps_boxes_within_1m_to_touch():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "GAP_SNAP_PX = 26.0" in html  # 1.0m at PX_PER_METER=26.0
    assert "function findNearestGapDelta" in html
    assert "function snapToNearbyNeighbors" in html
    assert "snapToNearbyNeighbors(active)" in html


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

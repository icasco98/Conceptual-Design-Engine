from src.geometry import compute_buildable_envelope
from src.interactive_canvas import (
    BITE_MAX_FRACTION,
    SCHEDULE_MIN_WIDTH_PX,
    _polygon_clipping_js,
    canvas_size_px,
    render_canvas_html,
)
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
    # push magnitude, and the footprint union builds each box's polygon
    # from its true rotated corners (obbOf/cornersOfObb), never the AABB.
    assert "function effectiveRectOf" in html
    assert "effectiveRectOf(a), rb = effectiveRectOf(b)" in html
    assert "function obbOf" in html
    assert "function cornersOfObb" in html
    assert "function polyOfBox" in html
    assert "cornersOfObb(obbOf(el))" in html


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


def test_footprint_union_uses_the_vendored_boolean_library():
    """Boolean polygon geometry is the library's job now. Two hand-rolled
    generations of it -- a rectilinear rasterizer, then an edge-splitting
    union -- are where this project's outline bugs came from."""
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "polygonClipping.union.apply" in html
    assert "function computeFootprintPath" in html
    # Neither hand-rolled generation survives.
    assert "covered[i][j]" not in html
    assert "isCovered(" not in html
    assert "function weldEndpoints" not in html
    assert "function segCrossT" not in html
    assert "function clipToHalfPlane" not in html


def test_library_is_inlined_not_fetched_from_a_cdn():
    """The diagram promises to be a self-contained document -- a CDN script
    tag would make it fail offline, and the app is often run locally."""
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "polygonClipping" in html
    assert "cdn." not in html
    assert "<script src=" not in html
    assert len(html) > len(_polygon_clipping_js())


def test_a_rotated_room_bites_its_neighbor_instead_of_shoving_it():
    """The point of the carve: rotation stays a local edit. A rotated room
    takes the overlap and the neighbor gives it up, rather than the whole
    plan scattering to make room."""
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "function canAbsorbBite" in html
    # The collision gate reports an absorbable overlap as no overlap, which
    # is what keeps every push, shrink and cascade off the pair.
    assert "if (canAbsorbBite(a, b) || canAbsorbBite(b, a)) return false;" in html
    # Rotation refuses rather than displaces -- pushes are one-way, so one
    # awkward angle mid-drag used to permanently scatter the layout.
    assert "function rotationIsAllowed" in html
    assert "resolveOverlaps(rot.el)" not in html


def test_a_bite_is_refused_unless_the_room_stays_usable():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    # Minimum AREA is not a sufficient guard on its own: an L-shape can keep
    # its area as a dogleg nothing fits in, so the remaining shape must also
    # still hold the room's minimum RECTANGLE.
    assert "left < min.w * min.h" in html
    assert "function largestFreeStrip" in html
    assert f"BITE_MAX_FRACTION = {BITE_MAX_FRACTION}" in html
    # A cut that splits a room in two or punches a hole in it is refused --
    # that is also what stops circulation ever being severed.
    assert "if (!out || out.length !== 1) return null;" in html
    assert "if (out[0].length !== 1) return null;" in html


def test_carving_is_derived_never_written_back_to_the_rectangles():
    """Un-rotate and the neighbours must come back whole, so the carve has
    to be recomputed each frame from the rectangles, never stored."""
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "function morphedPolygonFor" in html
    assert "function growthHitsAnotherBox" in html
    assert "function applyDisplayShapes" in html
    # Painting moved to the .fill child so the box itself stays a plain
    # rectangle for the schedule, resize and collision.
    assert '<span class="fill"' in html
    assert ".room-box > .fill {" in html
    # Shapes are rebuilt before the footprint that consumes them.
    refresh = html.split("function refreshDiagram")[1][:200]
    assert refresh.index("applyDisplayShapes();") < refresh.index("updateFootprint();")


def test_box_sizes_come_from_the_inline_style_not_rounded_offsets():
    """offsetWidth rounds to whole pixels; against a fractional left that
    leaves flush rooms ~0.2px apart, which fragments the footprint union
    and made the schedule report 1.19m for a 1.20m hallway."""
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "el.style.width ? parseFloat(el.style.width) : el.offsetWidth" in html
    assert "el.style.height ? parseFloat(el.style.height) : el.offsetHeight" in html


def test_schedule_reports_the_area_a_carved_room_actually_has_left():
    """Width x depth stops being the whole story once a room is carved --
    an L-shape has no single width -- so the schedule carries a live area
    read from the drawn shape."""
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "Area (m&sup2;)" in html
    assert "schedule-area" in html
    assert "polyArea(shape)" in html
    # ...while the editable width/depth still drive the underlying rectangle.
    assert "function applyScheduleEdit" in html


def test_rotated_boxes_are_separated_by_their_real_shapes_not_bounding_boxes():
    """Two rooms turned toward each other must be able to touch. Pushing by
    the AABB overlap shoved them apart by the difference between the box and
    its bounding box, so each behaved as if sealed in an invisible square."""
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "function obbPenetration" in html
    assert "function eitherRotated" in html
    # Both separators take the true-shape path before the AABB one.
    assert html.count("obbPenetration(obbOf(a), obbOf(b))") >= 2


def test_carving_works_in_each_boxs_own_frame_so_rotated_rooms_carve_too():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "function frameOf" in html
    assert "function pageToLocalPoly" in html
    assert "function localToPagePoly" in html
    # A rotated victim is no longer refused outright.
    assert "if (rotationOf(victim)) return false;" not in html


def test_drag_work_is_coalesced_to_one_frame():
    """A high-polling-rate mouse delivers several moves per frame; running
    collision resolution and boolean geometry on each is what made a drag
    snag."""
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "requestAnimationFrame(runPendingMove)" in html
    assert "function runPendingMove" in html
    # A drag ending between frames still lands on its final position.
    assert "cancelAnimationFrame(moveFrame)" in html


def test_the_resolver_short_circuits_when_nothing_is_touching():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    # Sub-pixel tolerance: flush rooms differ by floating-point noise, and
    # without it the resolver "found" overlaps forever and ran all 48 passes
    # on every pointer move.
    assert "OVERLAP_EPS_PX" in html
    # Broad phase before any real work, and memoized/cached geometry.
    assert "if (!anyBoxesOverlap()) return;" in html
    assert "function anyBoxesOverlap" in html
    assert "el.__rectCache" in html
    assert "var absorbMemo" in html


def test_focusing_a_size_field_selects_its_room():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "wInput.addEventListener('focus'" in html
    assert "hInput.addEventListener('focus'" in html

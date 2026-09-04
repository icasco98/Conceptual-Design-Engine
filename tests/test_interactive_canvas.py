from src.engine import design
from src.geometry import compute_buildable_envelope
from src.interactive_canvas import (
    BITE_MAX_FRACTION,
    SCHEDULE_MIN_WIDTH_PX,
    DiagramText,
    _polygon_clipping_js,
    canvas_size_px,
    render_canvas_html,
)
from src.models import Project, Room, Setbacks, Site, SiteEdge
from src.zoning_spec import default_spec


def make_project(width=18.0, depth=25.0, rooms=None) -> Project:
    edges = [
        SiteEdge(position="front", adjacency="street"),
        SiteEdge(position="back", adjacency="neighbor"),
        SiteEdge(position="left", adjacency="neighbor"),
        SiteEdge(position="right", adjacency="neighbor"),
    ]
    site = Site(width_m=width, depth_m=depth, edges=edges)
    return Project(site=site, setbacks=Setbacks(), rooms=rooms or [])


def plan_for(project: Project):
    """Run the real engine on a project, exactly as app.py does, and hand
    back the packed result plus the diagram text."""
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    outcome = design(project, envelope, default_spec(project))
    assert outcome.plan is not None, outcome.messages
    return envelope, outcome.plan.result, DiagramText(outcome.title, outcome.rationale)


def _render(rooms):
    project = make_project(rooms=rooms)
    envelope, result, text = plan_for(project)
    return render_canvas_html(project, envelope, result, text), result


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
    project = make_project(width=12.0, depth=30.0, rooms=multi_row)
    envelope, result, text = plan_for(project)
    html = render_canvas_html(project, envelope, result, text)
    assert result.corridors
    assert html.count('class="corridor draggable"') == len(result.corridors)


def test_corridors_are_draggable_like_rooms_not_fixed():
    import re

    rooms = [
        Room(name="Entry", room_type="entry", is_entry=True),
        Room(name="Bedroom", room_type="bedroom_primary", count=4),
    ]
    project = make_project(width=12.0, depth=30.0, rooms=rooms)
    envelope, result, text = plan_for(project)
    html = render_canvas_html(project, envelope, result, text)
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


def test_the_dragged_room_is_never_moved_by_the_resolver():
    """The box under the cursor goes exactly where you put it. The old model
    shoved it whenever a neighbour could not give way, so the room fought
    the cursor -- measured at 8px of push-back on every frame."""
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "function resolveOverlaps" in html
    assert "if (mover === pinned) continue;" in html
    # The three-stage shrink/push/separate resolver is gone for good.
    assert "function shrinkAndPushNonPinned" not in html
    assert "function pushPinnedClearOfOverlaps" not in html
    assert "function forceSeparateAnyRemainingOverlaps" not in html



def test_rotation_inflates_the_effective_rect_used_for_collision_and_footprint():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    # Rotating a box does push its neighbors and does grow the footprint --
    # resolveOverlaps reads the rotated bounding box (effectiveRectOf) for
    # push magnitude, and the footprint union builds each box's polygon
    # from its true rotated corners (obbOf/cornersOfObb), never the AABB.
    assert "function effectiveRectOf" in html
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
    # Every question about whether two boxes are really touching goes
    # through the true rotated shapes, never the bounding boxes.
    assert "function boxesTrulyIntersect" in html
    assert html.count("boxesTrulyIntersect(") >= 4


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

    assert "Zoned by privacy" in html
    assert "Public" in html and "Private" in html and "Service" in html
    assert "meets the street" in html
    assert html.count('class="legend-item"') == 6  # 3 zones + Hallway + Entry + Door


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
    # is what keeps every push and cascade off the pair.
    assert "if (chooseBiteVictim(a, b)) return false;" in html
    # The box under the cursor bites; the stationary one gives way. Pushing
    # the room you are deliberately moving is not what you asked for.
    assert "function biteVictim" in html
    assert "if (pinnedBox === a) return b;" in html
    # One chooser used by the collision gate, the rotation check AND the
    # shape pass, so the room that gets vetted is the room that gets carved.
    # Approving one direction and drawing the other left rooms overlapping.
    assert "function chooseBiteVictim" in html
    assert html.count("chooseBiteVictim(") >= 4
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
    assert "function applyDisplayShapes" in html
    assert "function carvePlanFor" in html
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
    # The one place anything is moved uses the true penetration depth.
    assert "obbPenetration(obbOf(mover), obbOf(against))" in html


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


def test_any_room_can_carve_any_room_not_only_a_rotated_one():
    """Push two square rooms together and one draws itself as an L. That is
    how an L-shaped room gets made directly, instead of the only route being
    to rotate something into it."""
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    # The carve is no longer gated on the biter being rotated.
    assert "if (!rotationOf(biter) || victim === biter) return false;" not in html
    assert "function slackOf" in html
    # With neither room being dragged, the one with more spare area over its
    # own minimum gives way -- a bathroom at code minimum has nothing to give.
    assert "return slackOf(a) >= slackOf(b) ? a : b;" in html


def test_nothing_resizes_a_room_except_its_owner():
    """A room's size is set by its resize handle and the schedule's fields,
    and by nothing else. Collision used to shrink whatever it pushed, and
    the envelope clamp squashed whatever reached the setback line."""
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    # The resolver translates; it never computes a width or a height.
    resolver = html.split("function resolveOverlaps")[1].split("// ---- Boolean geometry")[0]
    assert "style.width" not in resolver
    assert "style.height" not in resolver
    # The envelope clamp stops a box at the line instead of squashing it.
    clamp = html.split("function clampToEnvelope")[1][:200]
    assert "clampPositionOnly(el)" in clamp
    assert "Math.max(m.w" not in clamp


def test_displacement_is_recomputed_from_where_the_drag_started():
    """Drag across the plan and back and everything springs back. Pushes
    used to be one-way and cumulative, so a room shoved aside stayed shoved
    after the thing that shoved it had gone."""
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "function takeGestureSnapshot" in html
    assert "function restoreOthersFromSnapshot" in html
    assert "restoreOthersFromSnapshot(active);" in html
    # Taken when the gesture starts and dropped when it ends, so the new
    # arrangement is the baseline for the next drag.
    assert "takeGestureSnapshot();" in html
    assert "gestureSnapshot = null;" in html


def test_a_room_is_never_cut_by_more_than_the_overlap():
    """No room may lose area to nothing. A cut that would split a room or
    hole it is refused outright rather than "keeping the largest piece" --
    that quietly deleted the rest, and the missing part showed on the
    diagram as a white wedge."""
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "function subtractLargestPiece" not in html
    # The tidy-up sweep may only take the overlap itself, and only from the
    # room that was chosen to give way.
    assert "if (chooseBiteVictim(el, live[s2]) !== el) continue;" in html
    assert "if (removed > overlap + 1) continue;" in html


def test_a_room_never_grows_beyond_its_own_rectangle():
    """Rooms give space up; they never take any. A room beside a rotated
    neighbour used to grow up to 2m into the void the rotation opened, and
    nobody could predict which room would grow, how far, or when -- rooms
    swelled and shrank as unrelated boxes moved nearby."""
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    # The display shape is the carve and nothing else.
    assert "return carvePlanFor(el, live).poly;" in html
    # Every part of the growth machinery is gone.
    assert "MORPH_REACH" not in html
    assert "function grownRectToward" not in html
    assert "function growthHitsAnotherBox" not in html
    assert "function distanceBetweenPolys" not in html
    assert "function clipPolyToEnvelope" not in html



def test_circulation_is_never_carved_by_anything():
    """A hallway narrower than the code minimum stops being a hallway. The
    guards only ask whether SOME minimum rectangle survives, which a 17m
    corridor always has either side of a bite -- so a rotated room ate one
    down to 0.21m of clear width and nothing objected."""
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    # Preferred victim is the room, and there is no falling back onto the
    # corridor when the room cannot give way -- the pair is pushed instead.
    assert "if (aCorridor !== bCorridor) return aCorridor ? b : a;" in html
    assert "if (second.classList.contains('corridor')) return null;" in html


def test_the_minimum_rectangle_test_measures_the_actual_overlap():
    """Measured against the biter's whole bounding box instead, a long
    corridor rotated into a room's frame covers the entire room, every
    strip measures zero, and the room is judged unable to give up even a
    corner -- which refused rotation outright."""
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "var bite = bboxOf(overlapRegion || clipperLocal);" in html
    assert "polygonClipping.intersection(polyToGeom(base), polyToGeom(clipperLocal))" in html


def test_carve_first_protect_the_minimum_push_only_as_a_last_resort():
    """The three movement rules, in order. One function decides both what to
    draw and whether anything must move, so the two cannot disagree."""
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "function carvePlanFor" in html
    # Cumulative: three cuts can each look harmless alone and gut a room
    # together, so the test runs against the accumulating shape.
    assert "var cut = subtractPolys(poly, [candidates[c].clipper]);" in html
    assert "if (cut && shapeStillUsable(el, cut))" in html
    # Minimum area AND minimum rectangle; the SHAPE is deliberately unjudged.
    assert "function shapeStillUsable" in html
    assert "polyArea(poly) < m.w * m.h" in html
    # Pushing is the last resort, one room, one step, never a cascade.
    assert "if (movedAlready.indexOf(mover) !== -1) continue;" in html


def test_circulation_neither_gives_way_nor_gets_shoved():
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    # A room dragged onto a hallway bends around it...
    assert "if (aCorridor !== bCorridor) return aCorridor ? b : a;" in html
    # ...and if it cannot, the hallway still is not the thing that moves.
    assert "if (mover.classList.contains('corridor')) continue;" in html


def test_a_rotated_room_moves_freely():
    """Grid and gap snapping both work on the unrotated rectangle, which is
    not where a turned room is -- they fought the cursor rather than helping
    it, so a rotated room is exempt from both."""
    rooms = [Room(name="Entry", room_type="entry", is_entry=True), Room(name="Kitchen", room_type="kitchen")]
    html, _ = _render(rooms)

    assert "var freeMoving = !!rotationOf(active);" in html
    assert "if (!freeMoving) snapToNearbyNeighbors(active);" in html
    # The grab point is measured from the box's own position, not its
    # bounding rectangle, which for a rotated box made it jump on pickup.
    assert "offsetX = (p.x - cRect0.left) - r0.left;" in html
    # And the envelope clamp uses the true footprint, not the unrotated width.
    assert "ENV.right - eff.width + padLeft" in html

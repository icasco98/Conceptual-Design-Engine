"""The sample is what every visitor sees before typing a word, so it has to
render on the same code path a real project does — no special cases, no
validation warnings, no API call."""

from src.geometry import compute_buildable_envelope
from src.interactive_canvas import render_canvas_html
from src.layout import pack_rooms
from src.sample_project import sample_layout_plan, sample_project
from src.validation import validate_room_program


def test_sample_site_is_complete_enough_to_draw():
    project = sample_project()
    assert project.site.is_complete()
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    assert envelope.is_valid


def test_sample_program_raises_no_issues():
    """A warning triangle on the example project would read as the tool
    being broken, not as the example demonstrating a warning."""
    project = sample_project()
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    assert validate_room_program(project, envelope) == []


def test_sample_marks_exactly_one_entry():
    entries = [r for r in sample_project().rooms if r.is_entry]
    assert len(entries) == 1


def test_sample_plan_covers_every_room_exactly_once():
    """plan_layout's contract: one category per room, and a placement order
    naming each room once (counted rooms are expanded by the packer)."""
    project = sample_project()
    plan = sample_layout_plan()
    names = [room.name for room in project.rooms]

    assert sorted(a.room_name for a in plan.assignments) == sorted(names)
    assert sorted(plan.placement_order) == sorted(names)
    assert len({a.room_name for a in plan.assignments}) == len(names)


def test_sample_packs_and_renders_like_any_other_project():
    project = sample_project()
    plan = sample_layout_plan()
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    result = pack_rooms(project, envelope, plan.placement_order)

    # Counted rooms expand: 8 entries, 2 bedrooms and 2 bathrooms -> 10 boxes.
    assert len(result.rooms) == 10
    assert result.footprint

    html = render_canvas_html(
        project, envelope, result,
        {a.room_name: a.category for a in plan.assignments},
        plan,
    )
    for room in result.rooms:
        assert room.name in html
    assert 'id="canvas-container"' in html

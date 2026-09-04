"""The sample is what every visitor sees before typing a word, so it has to
pack on the same code path a real project does — no special cases, no
validation warnings, no API call."""

from src.geometry import compute_buildable_envelope
from src.layout import pack_levels
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


def test_sample_packs_like_any_other_project():
    project = sample_project()
    plan = sample_layout_plan()
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    building = pack_levels(project, envelope, plan.placement_order)

    # Two storeys. Ground: entry, stair, kitchen, dining, living, utility,
    # powder room, garage. Upstairs: stair again, primary, 2 bedrooms,
    # bathroom, study.
    assert len(building.level(0).rooms) == 8
    assert len(building.level(1).rooms) == 6
    assert building.footprint


def test_sample_places_every_room_it_promises():
    """This used to be checked by looking for each room's name in the rendered
    HTML. The drawing moved to the frontend, but the thing worth guarding did
    not: a room in the program that never reaches a level is a room the owner
    described and never sees."""
    project = sample_project()
    plan = sample_layout_plan()
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    building = pack_levels(project, envelope, plan.placement_order)

    placed = {room.name for result in building.levels for room in result.rooms}
    for room in project.rooms:
        assert any(name.startswith(room.name) for name in placed), room.name


def test_the_sample_opens_without_a_warning_of_any_kind():
    """The example is the tool's argument for itself. A plumbing warning on
    first paint reads as the tool being broken, not as the sample
    demonstrating a check -- and nobody reads it charitably."""
    from src.planner import best_layout
    from src.stacking import stacking_issues

    project = sample_project()
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    best = best_layout(project, envelope, sample_layout_plan())

    assert best.access_problems == 0
    assert stacking_issues(best.result) == []
    assert validate_room_program(project, envelope) == []

"""The sample is what every visitor sees before typing a word, so it has to
render on the same code path a real project does -- no special cases, no
validation warnings, no API call, and a plan that passes every hard rule."""

from src.engine import design
from src.geometry import compute_buildable_envelope
from src.interactive_canvas import DiagramText, render_canvas_html
from src.sample_project import sample_project, sample_spec
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


def test_sample_spec_covers_every_room_exactly_once():
    project = sample_project()
    spec = sample_spec()
    names = sorted(room.name for room in project.rooms)
    assert sorted(a.room_name for a in spec.assignments) == names
    assert "sample" in spec.rationale.lower()


def test_sample_plan_passes_every_hard_rule():
    """The example must be an example of the tool working: status ok, not
    relaxed or compromised."""
    project = sample_project()
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    outcome = design(project, envelope, sample_spec())
    assert outcome.status == "ok", outcome.messages
    assert outcome.validation is not None and outcome.validation.passed
    # Counted rooms expand: 10 entries, 2 bedrooms and 2 bathrooms -> 12 boxes.
    assert len(outcome.plan.result.rooms) == 12


def test_sample_says_something_about_the_site():
    """The sample faces north on purpose, so the site analysis has a sunny
    edge to talk about."""
    project = sample_project()
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    outcome = design(project, envelope, sample_spec())
    assert outcome.site.orientation_known
    assert outcome.site.sun_edge == "back"


def test_sample_renders_like_any_other_project():
    project = sample_project()
    envelope = compute_buildable_envelope(project.site, project.setbacks)
    outcome = design(project, envelope, sample_spec())
    html = render_canvas_html(
        project, envelope, outcome.plan.result, DiagramText(outcome.title, outcome.rationale)
    )
    for room in outcome.plan.result.rooms:
        assert room.name in html
    assert 'id="canvas-container"' in html

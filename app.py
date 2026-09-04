"""Conceptual Design Engine — Phase 1: Zoning Diagram Generator.

Current scope: a conversational intake that extracts a structured site +
room program from plain language, a deterministic geometry/validation
layer that computes the buildable envelope and checks the room program
against it, and a single interactive zoning diagram (src/interactive_canvas.py)
drawn by the zoning engine (src/engine.py): the site is read first, Claude
states the zoning problem as a specification (zones + adjacency matrix),
and plain Python proves the brief buildable, packs the candidates, validates
them against hard constraints and scores the survivors. The owner can then
drag rooms (and hallways) around by hand to explore other arrangements on
top of that recommendation.
"""

from __future__ import annotations

import json
import os

import streamlit as st
import streamlit.components.v1 as components
from dotenv import load_dotenv

from src.claude_client import explain_issues
from src.engine import DesignOutcome, design
from src.extraction import extract_project
from src.geometry import BuildableEnvelope, IncompleteSiteError, compute_buildable_envelope
from src.interactive_canvas import CANVAS_CHROME_HEIGHT_PX, DiagramText, canvas_size_px, render_canvas_html
from src.models import Project
from src.sample_project import sample_project, sample_spec
from src.site_analysis import analyse_site
from src.validation import Issue, validate_room_program
from src.validator import CIRCULATION_TARGET_HIGH, CIRCULATION_TARGET_LOW
from src.zoning_brief import try_propose_zoning
from src.zoning_spec import ZoningSpec, default_spec, reconcile_spec

load_dotenv()

st.set_page_config(page_title="Conceptual Design Engine — Zoning Intake", layout="wide")

# How tall the scrollable chat box is, in pixels, ONCE there is a
# conversation in it — capped so the diagram below is always visible
# without scrolling past a long conversation.
CHAT_HEIGHT_PX = 480
# Before the first message there's nothing to scroll, so the box only needs
# to hold the input itself — see render_chat.
EMPTY_CHAT_HEIGHT_PX = 90


def load_api_key_from_cloud_secrets() -> None:
    """When hosted on Streamlit Community Cloud, the key lives in st.secrets
    (set via the app's dashboard) rather than a local .env file. Mirror it
    into the environment so src.claude_client picks it up the same way
    either way."""
    if os.environ.get("ANTHROPIC_API_KEY"):
        return
    try:
        key = st.secrets["ANTHROPIC_API_KEY"]
    except Exception:
        return
    if key:
        os.environ["ANTHROPIC_API_KEY"] = key


load_api_key_from_cloud_secrets()

if not os.environ.get("ANTHROPIC_API_KEY"):
    st.error(
        "No Anthropic API key found. Locally: add it to a `.env` file. "
        "On Streamlit Community Cloud: add it under your app's Settings → Secrets "
        "as `ANTHROPIC_API_KEY = \"sk-ant-...\"`."
    )
    st.stop()


def init_state() -> None:
    """Open on the worked example (src/sample_project.py) rather than an
    empty canvas. `showing_sample` is what every "this isn't yours yet"
    caption keys off; the owner's first message clears it and replaces the
    project outright. `spec` is the zoning specification the engine works
    from -- the rule-based default until Claude has written one."""
    if "history" not in st.session_state:
        st.session_state.history = []
    if "project" not in st.session_state:
        st.session_state.project = sample_project()
        st.session_state.spec = sample_spec()
        st.session_state.showing_sample = True
    st.session_state.setdefault("spec", None)
    st.session_state.setdefault("spec_notes", [])
    st.session_state.setdefault("showing_sample", False)


def compute_envelope(project: Project) -> BuildableEnvelope | None:
    try:
        return compute_buildable_envelope(project.site, project.setbacks)
    except IncompleteSiteError:
        return None


def render_sidebar(
    project: Project,
    envelope: BuildableEnvelope | None,
    issues: list[Issue],
    showing_sample: bool,
) -> None:
    with st.sidebar:
        st.header("Sample project" if showing_sample else "Captured so far")
        if showing_sample:
            st.caption(
                "Nothing captured yet — this is a worked example so there's "
                "something to look at. Your first chat message replaces it."
            )

        if project.owner:
            st.caption(f"Owner: {project.owner}")

        st.subheader("Site")
        site = project.site
        if site.width_m is not None and site.depth_m is not None:
            st.write(f"{site.width_m:.1f} m x {site.depth_m:.1f} m")
        else:
            st.write("_not yet described_")
        if site.edges:
            st.table(
                [
                    {"edge": e.position, "adjacency": e.adjacency, "setback (m)": e.setback_override_m or "default"}
                    for e in site.edges
                ]
            )

        st.subheader("Setbacks")
        st.write(f"Street: {project.setbacks.street_m:.1f} m · Neighbor: {project.setbacks.neighbor_m:.1f} m")

        st.subheader("Buildable envelope")
        if envelope is None:
            st.write("_need full site geometry (width, depth, all 4 edges tagged)_")
        elif not envelope.is_valid:
            st.error("Setbacks leave no buildable area.")
        else:
            st.write(f"{envelope.width_m:.1f} m x {envelope.depth_m:.1f} m ({envelope.area_m2:.1f} m²)")

        # Zoning is fixed by the site before any room is placed -- this is
        # what was read off the plot, so the owner can see what the
        # diagram's arrangement follows from.
        st.subheader("Site analysis")
        if site.edges:
            for note in analyse_site(project).notes:
                st.write(f"- {note}")
        else:
            st.write("_nothing to read until the edges are described_")

        # No room table here on purpose. The diagram's own room schedule
        # (src/interactive_canvas.py, the panel left of the drawing) is the
        # single place rooms are listed.
        st.subheader(f"Room program ({len(project.rooms)})")
        if project.rooms:
            entry_count = sum(1 for r in project.rooms if r.is_entry)
            total = sum(r.count for r in project.rooms)
            st.write(
                f"{total} space{'s' if total != 1 else ''} captured"
                f"{' · entry marked' if entry_count else ' · no entry marked yet'}"
            )
            st.caption("Listed in the room schedule beside the diagram.")
        else:
            st.write("_no rooms described yet_")

        if project.priorities:
            st.subheader("Priorities")
            for p in project.priorities:
                st.write(f"- {p}")

        if issues:
            st.subheader("Issues")
            for issue in issues:
                (st.error if issue.severity == "error" else st.warning)(issue.message)

        st.divider()
        if st.button("Reset conversation"):
            st.session_state.history = []
            st.session_state.project = sample_project()
            st.session_state.spec = sample_spec()
            st.session_state.spec_notes = []
            st.session_state.showing_sample = True
            st.rerun()


def render_outcome_messages(outcome: DesignOutcome) -> None:
    """What the engine had to say beyond the drawing: a brief the gate had
    to relax, a plan that breaks a rule, or a program that can't be packed."""
    notes = list(st.session_state.spec_notes) + list(outcome.messages)
    if outcome.status == "rejected":
        st.error("**This brief can't be drawn as a plan.**  \n" + "  \n".join(notes))
        return
    if outcome.status == "relaxed":
        st.warning("**The brief as stated can't be built.**  \n" + "  \n".join(notes))
    elif outcome.status == "compromised":
        st.warning("**No arrangement satisfies every rule.**  \n" + "  \n".join(notes))
    elif notes:
        st.info("  \n".join(notes))


def render_interactive_canvas(
    project: Project,
    envelope: BuildableEnvelope | None,
    spec: ZoningSpec | None,
    showing_sample: bool,
) -> None:
    if showing_sample:
        st.subheader("Zoning Diagram — sample")
        st.caption(
            "A worked example on a 20 x 28 m lot facing north: street at the front, neighbors on the "
            "other three sides, the sun on the back garden. It's fully live — drag, resize and rotate "
            "it to get a feel for the canvas. Describe your own project in the chat and this is replaced."
        )
    else:
        st.subheader("Zoning Diagram")
    st.caption(
        "Drag a room — or a hallway — to explore a different arrangement. Spaces can never end up "
        "overlapping: moving one carves or nudges whatever it would overlap. The outline traces the "
        "building's own footprint, not the buildable site. Dragging is local to this browser view — "
        "sending a new chat message resets it to the recommendation."
    )

    if envelope is None or not envelope.is_valid:
        st.info("Once the site (size + all four edges) is described, the diagram will appear here.")
        return
    if not project.rooms:
        st.info("Describe some rooms in the chat and the diagram will appear here.")
        return
    if spec is None:
        spec = default_spec(project)

    # The whole pipeline -- site analysis, feasibility gate, candidates,
    # validation, scoring -- is deterministic and fast enough to run on
    # every rerun, so the diagram is never stale relative to the project.
    outcome = design(project, envelope, spec)
    render_outcome_messages(outcome)
    if outcome.plan is None:
        return

    st.caption(
        f"{outcome.passing} of {outcome.candidates} arrangements passed every hard rule "
        f"(walkable, private rooms deeper than shared ones, required adjacencies, no space over the "
        f"setback line); the best-scoring one is drawn. Hallway is scored against the "
        f"{int(CIRCULATION_TARGET_LOW * 100)}–{int(CIRCULATION_TARGET_HIGH * 100)}% of floor area "
        "a house normally spends on it."
    )

    html_doc = render_canvas_html(
        project, envelope, outcome.plan.result, DiagramText(outcome.title, outcome.rationale)
    )
    _, height_px = canvas_size_px(project.site)
    # A plain self-contained HTML/JS widget, not a Streamlit component:
    # dragging happens entirely in the browser with nothing sent back to
    # Python -- see the module docstring in src/interactive_canvas.py.
    components.html(html_doc, height=height_px + CANVAS_CHROME_HEIGHT_PX, scrolling=False)


def render_chat(history: list[dict]) -> str | None:
    """The scroll box only earns its full height once there's a conversation
    in it -- an empty 480px box on first load would push the sample diagram
    below the fold."""
    placeholder = "Describe your project — site, rooms, priorities..."
    with st.container(height=CHAT_HEIGHT_PX if history else EMPTY_CHAT_HEIGHT_PX):
        for msg in history:
            with st.chat_message(msg["role"]):
                st.markdown(msg["content"])
        return st.chat_input(placeholder)


def process_new_message(prompt: str) -> None:
    # The sample is never merged with the owner's project and never sent to
    # Claude: extraction reads the chat transcript alone.
    st.session_state.showing_sample = False
    st.session_state.history.append({"role": "user", "content": prompt})

    try:
        result = extract_project(st.session_state.history)
    except Exception as exc:  # noqa: BLE001 - surface any API/SDK error to the owner
        st.session_state.history.append({"role": "assistant", "content": f"Couldn't reach Claude: {exc}"})
        return

    st.session_state.history.append({"role": "assistant", "content": result.assistant_message})
    st.session_state.project = result.project

    new_envelope = compute_envelope(result.project)
    new_issues = validate_room_program(result.project, new_envelope)
    if new_issues:
        try:
            explanation = explain_issues(
                json.dumps(result.project.model_dump(mode="json"), indent=2),
                result.project.priorities,
                new_issues,
            )
            st.session_state.history.append({"role": "assistant", "content": explanation})
        except Exception as exc:  # noqa: BLE001
            st.session_state.history.append({"role": "assistant", "content": f"Couldn't reach Claude: {exc}"})

    # Station 03/04: Claude states the zoning problem. If it can't be
    # reached the rule-based default stands in, and the diagram still draws.
    if new_envelope is not None and new_envelope.is_valid and result.project.rooms:
        proposed = try_propose_zoning(result.project, analyse_site(result.project))
        spec, notes = reconcile_spec(result.project, proposed)
        st.session_state.spec = spec
        st.session_state.spec_notes = notes
    else:
        st.session_state.spec = None
        st.session_state.spec_notes = []


def main() -> None:
    init_state()

    st.title("Conceptual Design Engine")
    st.caption("Phase 1 — Zoning Diagram Generator")

    project = st.session_state.project
    envelope = compute_envelope(project)
    issues = validate_room_program(project, envelope)
    showing_sample = st.session_state.showing_sample
    render_sidebar(project, envelope, issues, showing_sample)

    prompt = render_chat(st.session_state.history)
    if prompt:
        with st.spinner("Reading that..."):
            process_new_message(prompt)
        st.rerun()

    render_interactive_canvas(
        st.session_state.project,
        envelope,
        st.session_state.spec,
        st.session_state.showing_sample,
    )


if __name__ == "__main__":
    main()

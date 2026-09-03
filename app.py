"""Conceptual Design Engine — Phase 1: Zoning Diagram Generator.

Current scope: a conversational intake that extracts a structured site +
room program from plain language, a deterministic geometry/validation
layer that computes the buildable envelope and checks the room program
against it, and a single interactive zoning diagram (src/interactive_canvas.py)
— Claude groups rooms into categories and suggests an adjacency order,
plain Python packs the actual rectangles (src/layout.py) so the geometry
is always trustworthy, and the owner can drag rooms (and hallways) around
by hand to explore other arrangements on top of that recommendation.
"""

from __future__ import annotations

import json
import os

import streamlit as st
import streamlit.components.v1 as components
from dotenv import load_dotenv

from src.access import access_problems_for
from src.claude_client import explain_issues
from src.extraction import extract_project
from src.geometry import BuildableEnvelope, IncompleteSiteError, compute_buildable_envelope
from src.interactive_canvas import CANVAS_CHROME_HEIGHT_PX, canvas_size_px, render_canvas_html
from src.layout_plan import LayoutPlan, plan_layout
from src.levels import assign_default_levels
from src.models import Project
from src.planner import CIRCULATION_TARGET_HIGH, CIRCULATION_TARGET_LOW, best_layout
from src.sample_project import sample_layout_plan, sample_project
from src.stacking import stacking_issues
from src.validation import Issue, validate_room_program

load_dotenv()

st.set_page_config(page_title="Conceptual Design Engine — Zoning Intake", layout="wide")

# How tall the scrollable chat box is, in pixels, ONCE there is a
# conversation in it — capped so the diagram below is always visible
# without scrolling past a long conversation. Tweak this if you'd like
# more/less chat visible at once.
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

# The key only gates the chat. The worked example, the packer, validation
# and the interactive canvas need no API call, so they keep working without
# one -- a visitor without a key still gets a live diagram to explore.
HAS_API_KEY = bool(os.environ.get("ANTHROPIC_API_KEY", "").strip()) and not os.environ.get(
    "ANTHROPIC_API_KEY", ""
).strip().endswith("...")
if not HAS_API_KEY:
    st.warning(
        "No Anthropic API key found, so the chat is disabled. Everything else works. "
        "Locally: add the key to a `.env` file. On Streamlit Community Cloud: add it "
        "under your app's Settings → Secrets as `ANTHROPIC_API_KEY = \"sk-ant-...\"`."
    )


def init_state() -> None:
    """Open on the worked example (src/sample_project.py) rather than an
    empty canvas, so the first thing on screen is a diagram to drag around
    instead of a placeholder describing one. `showing_sample` is what every
    "this isn't yours yet" caption keys off; the owner's first message
    clears it and replaces the project outright."""
    if "history" not in st.session_state:
        st.session_state.history = []
    if "project" not in st.session_state:
        st.session_state.project = sample_project()
        st.session_state.layout_plan = sample_layout_plan()
        st.session_state.showing_sample = True
    st.session_state.setdefault("layout_plan", None)
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

        # No room table here on purpose. The diagram's own room schedule
        # (src/interactive_canvas.py, the panel left of the drawing) is the
        # single place rooms are listed — it's live-synced with the canvas
        # and editable, which a server-rendered st.table can't be, and two
        # room tables on one screen invited the question of which one was
        # authoritative. Only the count is echoed here as intake context.
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
            st.session_state.layout_plan = sample_layout_plan()
            st.session_state.showing_sample = True
            st.rerun()


def render_interactive_canvas(
    project: Project,
    envelope: BuildableEnvelope | None,
    layout_plan: LayoutPlan | None,
    showing_sample: bool,
) -> None:
    if showing_sample:
        st.subheader("Zoning Diagram — sample")
        st.caption(
            "A worked example on a 20 x 28 m lot: street at the front, neighbors on the "
            "other three sides. It's fully live — drag, resize and rotate it to get a feel "
            "for the canvas. Describe your own project in the chat and this is replaced."
        )
    else:
        st.subheader("Zoning Diagram")
    st.caption(
        "Drag a room — or a hallway — to explore a different arrangement. Sizes and colors "
        "stay the same, only position changes, and spaces can never end up overlapping: moving "
        "one nudges anything it would overlap out of the way. The outline traces the building's "
        "own footprint, not the buildable site. Dragging is local to this browser view — sending "
        "a new chat message resets it to Claude's recommendation."
    )

    if envelope is None or not envelope.is_valid:
        st.info("Once the site (size + all four edges) is described, the diagram will appear here.")
        return
    if not project.rooms:
        st.info("Describe some rooms in the chat and the diagram will appear here.")
        return
    if layout_plan is None:
        st.info("Working out a room grouping — say a bit more and it'll appear here.")
        return

    # Not the first arrangement the packer produces -- several are packed,
    # their corridors thinned to what access actually needs, and the best
    # scoring one drawn (src/planner.py).
    chosen = best_layout(project, envelope, layout_plan)
    building = chosen.result

    st.caption(
        f"{chosen.notes}. Circulation is scored against the "
        f"{int(CIRCULATION_TARGET_LOW * 100)}–{int(CIRCULATION_TARGET_HIGH * 100)}% "
        "of floor area a house normally spends on it — corridors are kept only where a "
        "room depends on one to be reachable."
    )

    access_problems = access_problems_for(building)
    if access_problems:
        st.warning(
            "**Circulation problems in this layout** — "
            + " ".join(p.message for p in access_problems[:4])
            + (f" (+{len(access_problems) - 4} more)" if len(access_problems) > 4 else "")
            + "  \nDrag the rooms to open a route, or describe the change you want in the chat."
        )
    if project.storeys > 1:
        for issue in stacking_issues(building):
            st.warning(issue.message)

    # One canvas per storey, chosen with a selector. The stair is the same
    # rectangle on every level it connects, so it appears on each.
    if project.storeys > 1:
        labels = ["Ground floor"] + [f"Level {i}" for i in range(1, project.storeys)]
        picked = st.radio("Storey", labels, horizontal=True, key="level_picker")
        result = building.level(labels.index(picked))
    else:
        result = building.ground

    assignments = {a.room_name: a.category for a in layout_plan.assignments}
    html_doc = render_canvas_html(project, envelope, result, assignments, layout_plan)
    _, height_px = canvas_size_px(project.site)

    # A plain self-contained HTML/JS widget, not a Streamlit component:
    # dragging happens entirely in the browser with nothing sent back to
    # Python, so there's no round trip for the two states to fall out of
    # sync over — see the module docstring in src/interactive_canvas.py.
    # Extra headroom above the canvas's own pixel size for the title,
    # legend, reset button and rationale caption. The room schedule sits
    # in a column to the LEFT of the drawing rather than below it, so it
    # adds width, not height.
    components.html(html_doc, height=height_px + CANVAS_CHROME_HEIGHT_PX, scrolling=False)


def render_chat(history: list[dict]) -> str | None:
    """The scroll box only earns its full height once there's a conversation
    in it. On first load an empty 480px box would push the sample diagram
    below the fold, which defeats the point of opening on one. It still
    stays a container rather than a bare input, so the input doesn't jump
    to a different place on the page after the first message."""
    placeholder = (
        "Describe your project — site, rooms, priorities..."
        if HAS_API_KEY
        else "Chat disabled — add an ANTHROPIC_API_KEY to enable it"
    )
    with st.container(height=CHAT_HEIGHT_PX if history else EMPTY_CHAT_HEIGHT_PX):
        for msg in history:
            with st.chat_message(msg["role"]):
                st.markdown(msg["content"])
        return st.chat_input(placeholder, disabled=not HAS_API_KEY)


def process_new_message(prompt: str) -> None:
    # The sample is never merged with the owner's project and never sent to
    # Claude: extraction reads the chat transcript alone, which up to this
    # point is empty.
    st.session_state.showing_sample = False
    st.session_state.history.append({"role": "user", "content": prompt})

    try:
        result = extract_project(st.session_state.history)
    except Exception as exc:  # noqa: BLE001 - surface any API/SDK error to the owner
        st.session_state.history.append({"role": "assistant", "content": f"Couldn't reach Claude: {exc}"})
        return

    st.session_state.history.append({"role": "assistant", "content": result.assistant_message})
    # A multi-storey house described without saying what goes where opens
    # on the architect's first sketch -- bedrooms up, living down -- rather
    # than a bungalow with an empty floor above (src/levels.py).
    st.session_state.project = assign_default_levels(result.project)

    project = st.session_state.project
    new_envelope = compute_envelope(project)
    new_issues = validate_room_program(project, new_envelope)
    # Warnings already show in the sidebar; only spend an API call explaining
    # when something is actually blocking (an error-severity issue).
    if any(issue.severity == "error" for issue in new_issues):
        try:
            explanation = explain_issues(
                json.dumps(project.model_dump(mode="json"), indent=2),
                project.priorities,
                new_issues,
            )
            st.session_state.history.append({"role": "assistant", "content": explanation})
        except Exception as exc:  # noqa: BLE001
            st.session_state.history.append({"role": "assistant", "content": f"Couldn't reach Claude: {exc}"})

    if new_envelope is not None and new_envelope.is_valid and project.rooms:
        try:
            st.session_state.layout_plan = plan_layout(project)
        except Exception:  # noqa: BLE001 - diagram just won't refresh this turn
            pass
    else:
        st.session_state.layout_plan = None


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
        st.session_state.layout_plan,
        st.session_state.showing_sample,
    )


if __name__ == "__main__":
    main()

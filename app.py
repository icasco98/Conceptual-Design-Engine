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

from src.claude_client import explain_issues
from src.extraction import extract_project
from src.geometry import BuildableEnvelope, IncompleteSiteError, compute_buildable_envelope
from src.interactive_canvas import canvas_size_px, render_canvas_html
from src.layout import pack_rooms
from src.layout_plan import LayoutPlan, plan_layout
from src.models import Project
from src.validation import Issue, validate_room_program

load_dotenv()

st.set_page_config(page_title="Conceptual Design Engine — Zoning Intake", layout="wide")

# How tall the scrollable chat box is, in pixels — capped so the diagram
# below is always visible without scrolling past a long conversation.
# Tweak this if you'd like more/less chat visible at once.
CHAT_HEIGHT_PX = 480


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
    if "history" not in st.session_state:
        st.session_state.history = []
    if "project" not in st.session_state:
        st.session_state.project = Project()
    if "layout_plan" not in st.session_state:
        st.session_state.layout_plan = None


def compute_envelope(project: Project) -> BuildableEnvelope | None:
    try:
        return compute_buildable_envelope(project.site, project.setbacks)
    except IncompleteSiteError:
        return None


def render_sidebar(project: Project, envelope: BuildableEnvelope | None, issues: list[Issue]) -> None:
    with st.sidebar:
        st.header("Captured so far")

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

        st.subheader(f"Room program ({len(project.rooms)})")
        if project.rooms:
            st.table(
                [
                    {
                        "name": r.name,
                        "type": r.room_type,
                        "count": r.count,
                        "entry": "yes" if r.is_entry else "",
                    }
                    for r in project.rooms
                ]
            )
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
            st.session_state.project = Project()
            st.session_state.layout_plan = None
            st.rerun()


def render_interactive_canvas(
    project: Project,
    envelope: BuildableEnvelope | None,
    layout_plan: LayoutPlan | None,
) -> None:
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

    result = pack_rooms(project, envelope, layout_plan.placement_order)
    assignments = {a.room_name: a.category for a in layout_plan.assignments}
    html_doc = render_canvas_html(project, envelope, result, assignments, layout_plan)
    _, height_px = canvas_size_px(project.site)

    # A plain self-contained HTML/JS widget, not a Streamlit component:
    # dragging happens entirely in the browser with nothing sent back to
    # Python, so there's no round trip for the two states to fall out of
    # sync over — see the module docstring in src/interactive_canvas.py.
    # Extra headroom above the canvas's own pixel size for the title,
    # legend, reset button, and rationale caption rendered alongside it.
    components.html(html_doc, height=height_px + 220, scrolling=False)


def render_chat(history: list[dict]) -> str | None:
    chat_box = st.container(height=CHAT_HEIGHT_PX)
    with chat_box:
        for msg in history:
            with st.chat_message(msg["role"]):
                st.markdown(msg["content"])
        return st.chat_input("Describe your project — site, rooms, priorities...")


def process_new_message(prompt: str) -> None:
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

    if new_envelope is not None and new_envelope.is_valid and result.project.rooms:
        try:
            st.session_state.layout_plan = plan_layout(result.project)
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
    render_sidebar(project, envelope, issues)

    prompt = render_chat(st.session_state.history)
    if prompt:
        with st.spinner("Reading that..."):
            process_new_message(prompt)
        st.rerun()

    render_interactive_canvas(st.session_state.project, envelope, st.session_state.layout_plan)


if __name__ == "__main__":
    main()

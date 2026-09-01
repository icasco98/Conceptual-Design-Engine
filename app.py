"""Conceptual Design Engine — Phase 1: Zoning Diagram Generator (intake stage).

Current scope: a conversational intake that extracts a structured site +
room program from plain language, and a deterministic geometry/validation
layer that computes the buildable envelope and checks the room program
against it. The interactive drag-to-arrange zoning canvas comes next — see
README.md for the roadmap.
"""

from __future__ import annotations

import json
import os

import matplotlib.patches as patches
import matplotlib.pyplot as plt
import streamlit as st
from dotenv import load_dotenv

from src.claude_client import explain_issues
from src.extraction import extract_project
from src.geometry import BuildableEnvelope, IncompleteSiteError, compute_buildable_envelope
from src.models import Project
from src.validation import Issue, validate_room_program

load_dotenv()

st.set_page_config(page_title="Conceptual Design Engine — Zoning Intake", layout="wide")


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


def compute_envelope(project: Project) -> BuildableEnvelope | None:
    try:
        return compute_buildable_envelope(project.site, project.setbacks)
    except IncompleteSiteError:
        return None


def render_envelope_plot(project: Project, envelope: BuildableEnvelope) -> None:
    site = project.site
    fig, ax = plt.subplots(figsize=(4, 4))

    ax.add_patch(
        patches.Rectangle((0, 0), site.width_m, site.depth_m, fill=False, edgecolor="#888888", linewidth=1.5)
    )
    ax.add_patch(
        patches.Rectangle(
            (envelope.left_setback_m, envelope.back_setback_m),
            envelope.width_m,
            envelope.depth_m,
            fill=True,
            facecolor="#cfe8ff",
            edgecolor="#1f77b4",
            linewidth=1.5,
        )
    )

    ax.set_xlim(-0.5, site.width_m + 0.5)
    ax.set_ylim(-0.5, site.depth_m + 0.5)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_title("Site (gray) / Buildable envelope (blue)", fontsize=9)
    st.pyplot(fig, use_container_width=True)
    plt.close(fig)


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
            render_envelope_plot(project, envelope)

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
            st.rerun()


def main() -> None:
    init_state()

    st.title("Conceptual Design Engine")
    st.caption("Phase 1 — Zoning Diagram Generator (conversational intake)")

    project = st.session_state.project
    envelope = compute_envelope(project)
    issues = validate_room_program(project, envelope)
    render_sidebar(project, envelope, issues)

    for msg in st.session_state.history:
        with st.chat_message(msg["role"]):
            st.markdown(msg["content"])

    prompt = st.chat_input("Describe your project — site, rooms, priorities...")
    if not prompt:
        return

    st.session_state.history.append({"role": "user", "content": prompt})
    with st.chat_message("user"):
        st.markdown(prompt)

    with st.chat_message("assistant"):
        with st.spinner("Reading that..."):
            try:
                result = extract_project(st.session_state.history)
            except Exception as exc:  # noqa: BLE001 - surface any API/SDK error to the owner
                st.error(f"Couldn't reach Claude: {exc}")
                return
        st.markdown(result.assistant_message)

    st.session_state.history.append({"role": "assistant", "content": result.assistant_message})
    st.session_state.project = result.project

    new_envelope = compute_envelope(result.project)
    new_issues = validate_room_program(result.project, new_envelope)
    if new_issues:
        with st.chat_message("assistant"):
            with st.spinner("Checking that against the site..."):
                explanation = explain_issues(
                    json.dumps(result.project.model_dump(mode="json"), indent=2),
                    result.project.priorities,
                    new_issues,
                )
            st.markdown(explanation)
        st.session_state.history.append({"role": "assistant", "content": explanation})

    st.rerun()


if __name__ == "__main__":
    main()

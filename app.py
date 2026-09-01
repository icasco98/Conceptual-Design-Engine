"""Conceptual Design Engine — Phase 1: Zoning Diagram Generator.

Current scope: a conversational intake that extracts a structured site +
room program from plain language, a deterministic geometry/validation
layer that computes the buildable envelope and checks the room program
against it, a color-coded zoning diagram — Claude groups rooms into
categories and suggests an adjacency order, then plain Python packs the
actual rectangles (src/layout.py) so the geometry is always trustworthy —
and an interactive canvas (src/interactive_canvas.py) where the owner can
drag rooms around by hand to explore other arrangements on top of that
recommendation.
"""

from __future__ import annotations

import json
import os

import matplotlib.patches as patches
import matplotlib.pyplot as plt
import streamlit as st
import streamlit.components.v1 as components
from dotenv import load_dotenv
from matplotlib.lines import Line2D

from src.claude_client import explain_issues
from src.extraction import extract_project
from src.geometry import BuildableEnvelope, IncompleteSiteError, compute_buildable_envelope
from src.interactive_canvas import canvas_size_px, render_canvas_html
from src.layout import PlacedRoom, pack_rooms
from src.layout_plan import LayoutPlan, plan_layout
from src.models import Project
from src.palette import CATEGORY_COLORS, CIRCULATION_HATCH, ENTRY_BORDER_COLOR
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


def _site_edge_boundary(position: str, width: float, depth: float) -> tuple:
    return {
        "front": ((0, depth), (width, depth)),
        "back": ((0, 0), (width, 0)),
        "left": ((0, 0), (0, depth)),
        "right": ((width, 0), (width, depth)),
    }[position]


def _site_edge_label_anchor(position: str, width: float, depth: float, offset: float = 0.6) -> tuple:
    return {
        "front": ((width / 2, depth + offset), "center", "bottom"),
        "back": ((width / 2, -offset), "center", "top"),
        "left": ((-offset, depth / 2), "right", "center"),
        "right": ((width + offset, depth / 2), "left", "center"),
    }[position]


def render_zoning_diagram(
    project: Project,
    envelope: BuildableEnvelope | None,
    layout_plan: LayoutPlan | None,
) -> None:
    st.subheader("Zoning Diagram")

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
    labels = layout_plan.category_labels

    site = project.site
    fig, ax = plt.subplots(figsize=(9, 9 * site.depth_m / site.width_m if site.width_m else 9))

    ax.add_patch(
        patches.Rectangle((0, 0), site.width_m, site.depth_m, fill=False, edgecolor="#888888", linewidth=1.5)
    )
    for edge in site.edges:
        if edge.adjacency != "street":
            continue
        (x0, y0), (x1, y1) = _site_edge_boundary(edge.position, site.width_m, site.depth_m)
        ax.plot([x0, x1], [y0, y1], color="#c0392b", linewidth=4, solid_capstyle="butt", zorder=4)
        (lx, ly), ha, va = _site_edge_label_anchor(edge.position, site.width_m, site.depth_m)
        ax.text(lx, ly, "STREET", color="#c0392b", fontsize=8, fontweight="bold", ha=ha, va=va, zorder=4)

    for corridor in result.corridors:
        ax.add_patch(
            patches.Rectangle(
                (corridor.x_m, corridor.y_m),
                corridor.width_m,
                corridor.depth_m,
                facecolor="#f2f2f2",
                edgecolor="#999999",
                hatch=CIRCULATION_HATCH,
                linewidth=0.8,
            )
        )

    def room_style(room: PlacedRoom) -> dict:
        category = assignments.get(room.base_name, "category_a")
        style = {"facecolor": CATEGORY_COLORS.get(category, "#cccccc"), "edgecolor": "#333333", "linewidth": 1.0}
        if room.is_entry:
            style["edgecolor"] = ENTRY_BORDER_COLOR
            style["linewidth"] = 3.0
            style["linestyle"] = "--"
        return style

    for room in result.rooms:
        ax.add_patch(patches.Rectangle((room.x_m, room.y_m), room.width_m, room.depth_m, **room_style(room)))
        ax.text(
            room.x_m + room.width_m / 2,
            room.y_m + room.depth_m / 2,
            room.name,
            ha="center",
            va="center",
            fontsize=8,
            wrap=True,
            zorder=3,
        )

    for start, end in result.circulation_edges:
        ax.annotate(
            "",
            xy=end,
            xytext=start,
            arrowprops=dict(arrowstyle="-|>", color="#0b0b0b", lw=1.3, alpha=0.6, shrinkA=6, shrinkB=6),
            zorder=2,
        )

    legend_handles = [
        patches.Patch(facecolor=CATEGORY_COLORS[key], edgecolor="#333333", label=getattr(labels, key))
        for key in ("category_a", "category_b", "category_c")
    ]
    legend_handles.append(
        patches.Patch(facecolor="#f2f2f2", edgecolor="#999999", hatch=CIRCULATION_HATCH, label="Corridor")
    )
    legend_handles.append(
        patches.Patch(facecolor="white", edgecolor=ENTRY_BORDER_COLOR, linewidth=2, linestyle="--", label="Entry")
    )
    legend_handles.append(Line2D([0], [0], color="#0b0b0b", alpha=0.6, lw=1.3, label="Circulation path"))
    ax.legend(handles=legend_handles, loc="upper left", bbox_to_anchor=(1.02, 1.0), fontsize=8, frameon=False)

    ax.set_xlim(-1.2, site.width_m + 1.2)
    ax.set_ylim(-1.2, site.depth_m + 1.2)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_title(layout_plan.grouping_label, fontsize=10)
    fig.tight_layout()
    st.pyplot(fig, use_container_width=True)
    plt.close(fig)

    st.caption(layout_plan.rationale)


def render_interactive_canvas(
    project: Project,
    envelope: BuildableEnvelope | None,
    layout_plan: LayoutPlan | None,
) -> None:
    st.subheader("Try Rearranging Rooms")
    st.caption(
        "Drag a room to explore a different arrangement. Sizes and colors stay the same as "
        "the recommendation above — only position changes. Circulation arrows and issue "
        "checks above reflect Claude's recommendation, not what you drag here. Dragging is "
        "local to this browser view — sending a new chat message resets it to the recommendation."
    )

    if envelope is None or not envelope.is_valid or not project.rooms or layout_plan is None:
        st.info("This fills in once the zoning diagram above does.")
        return

    result = pack_rooms(project, envelope, layout_plan.placement_order)
    assignments = {a.room_name: a.category for a in layout_plan.assignments}
    html_doc = render_canvas_html(project, envelope, result, assignments)
    _, height_px = canvas_size_px(project.site)

    # A plain self-contained HTML/JS widget, not a Streamlit component:
    # dragging happens entirely in the browser with nothing sent back to
    # Python, so there's no round trip for the two states to fall out of
    # sync over — see the module docstring in src/interactive_canvas.py.
    components.html(html_doc, height=height_px + 50, scrolling=False)


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

    render_zoning_diagram(st.session_state.project, envelope, st.session_state.layout_plan)
    render_interactive_canvas(st.session_state.project, envelope, st.session_state.layout_plan)


if __name__ == "__main__":
    main()

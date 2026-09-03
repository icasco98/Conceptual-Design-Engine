"""The HTTP surface. Run with `uvicorn api.main:app --reload`.

Every route is a wrapper over src/. Read the docstrings there for what
the numbers mean; here is only which function answers which URL, and the
JSON shapes in api/serialize.py.

When frontend/dist exists (the built TypeScript app), it is served at /,
so one process is the whole tool on the owner's computer.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any, TypeVar

import anthropic
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from api import store
from api.serialize import (
    AccessProblemOut,
    ArrangementIn,
    BuildingOut,
    IssueOut,
    access_problem_out,
    building_from_arrangement,
    building_out,
    issue_out,
)
from src.access import access_problems_for
from src.claude_client import explain_issues
from src.extraction import extract_project
from src.geometry import BuildableEnvelope, IncompleteSiteError, compute_buildable_envelope
from src.layout_plan import LayoutPlan, plan_layout
from src.levels import assign_default_levels
from src.models import Project
from src.planner import best_layout
from src.sample_project import sample_layout_plan, sample_project
from src.stacking import stacking_issues
from src.validation import validate_room_program

load_dotenv()

app = FastAPI(title="Conceptual Design Engine API", version="0.1.0")

# The Vite dev server runs on another port during development. In the
# built app everything is same-origin and this is moot.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def has_api_key() -> bool:
    """A real key, not the placeholder an untouched .env still carries."""
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    return bool(key) and not key.endswith("...")


log = logging.getLogger("cde")

T = TypeVar("T")


def call_claude(step: str, fn: Callable[[], T]) -> T:
    """Run one Claude call and turn any failure into something the owner can
    act on.

    Without this every API problem reached the browser as "Internal Server
    Error", which says nothing about the thing that actually needs fixing --
    a mistyped key, an account with no credit, a dropped connection. The
    full traceback still goes to the terminal for anything unexpected.
    """
    try:
        return fn()
    except anthropic.AuthenticationError as exc:
        raise HTTPException(
            status_code=502,
            detail="Anthropic rejected the API key. Check ANTHROPIC_API_KEY in your .env file "
            "(no quotes, no spaces), then restart the app. Keys start with 'sk-ant-'.",
        ) from exc
    except anthropic.PermissionDeniedError as exc:
        raise HTTPException(
            status_code=502,
            detail="That API key isn't allowed to use this model. Check the key's permissions at "
            "console.anthropic.com.",
        ) from exc
    except anthropic.RateLimitError as exc:
        raise HTTPException(
            status_code=502, detail="Anthropic is rate-limiting this key. Wait a moment and try again."
        ) from exc
    except anthropic.APIConnectionError as exc:
        raise HTTPException(
            status_code=502,
            detail="Couldn't reach Anthropic. Check your internet connection and try again.",
        ) from exc
    except anthropic.APIStatusError as exc:
        message = getattr(exc, "message", "") or str(exc)
        if "credit balance" in message.lower() or "billing" in message.lower():
            detail = (
                "Your Anthropic account has no credit left, so Claude declined the request. "
                "Add credit at console.anthropic.com under Billing, then try again."
            )
        else:
            detail = f"Anthropic returned an error ({exc.status_code}): {message}"
        raise HTTPException(status_code=502, detail=detail) from exc
    except Exception as exc:
        log.exception("%s failed", step)
        raise HTTPException(status_code=500, detail=f"{step} failed: {type(exc).__name__}: {exc}") from exc


def envelope_for(project: Project) -> BuildableEnvelope | None:
    try:
        return compute_buildable_envelope(project.site, project.setbacks)
    except IncompleteSiteError:
        return None


class EnvelopeOut(BaseModel):
    valid: bool
    width_m: float
    depth_m: float
    area_m2: float
    front_setback_m: float
    back_setback_m: float
    left_setback_m: float
    right_setback_m: float


def envelope_out(envelope: BuildableEnvelope) -> EnvelopeOut:
    return EnvelopeOut(
        valid=envelope.is_valid,
        width_m=envelope.width_m,
        depth_m=envelope.depth_m,
        area_m2=envelope.area_m2,
        front_setback_m=envelope.front_setback_m,
        back_setback_m=envelope.back_setback_m,
        left_setback_m=envelope.left_setback_m,
        right_setback_m=envelope.right_setback_m,
    )


# ---------------------------------------------------------------- health


class HealthOut(BaseModel):
    ok: bool = True
    has_api_key: bool


@app.get("/api/health", response_model=HealthOut)
def health() -> HealthOut:
    return HealthOut(has_api_key=has_api_key())


# ---------------------------------------------------------------- sample


class SampleOut(BaseModel):
    project: Project
    layout_plan: LayoutPlan


@app.get("/api/sample", response_model=SampleOut)
def sample() -> SampleOut:
    return SampleOut(project=sample_project(), layout_plan=sample_layout_plan())


# ---------------------------------------------------------------- layout


class LayoutIn(BaseModel):
    project: Project
    layout_plan: LayoutPlan | None = None


class LayoutOut(BaseModel):
    envelope: EnvelopeOut | None
    issues: list[IssueOut]
    building: BuildingOut | None
    access_problems: list[AccessProblemOut]
    stacking_issues: list[IssueOut]
    notes: str
    circulation_ratio: float
    placement_order: list[str]


@app.post("/api/layout", response_model=LayoutOut)
def layout(body: LayoutIn) -> LayoutOut:
    """Claude's recommendation, packed: the best of several candidate
    arrangements for this project and plan (src/planner.py)."""
    project = body.project
    envelope = envelope_for(project)
    issues = validate_room_program(project, envelope)
    if envelope is None or not envelope.is_valid or not project.rooms:
        return LayoutOut(
            envelope=envelope_out(envelope) if envelope else None,
            issues=[issue_out(i) for i in issues],
            building=None, access_problems=[], stacking_issues=[],
            notes="site or rooms not described yet", circulation_ratio=0.0, placement_order=[],
        )
    chosen = best_layout(project, envelope, body.layout_plan)
    building = chosen.result
    return LayoutOut(
        envelope=envelope_out(envelope),
        issues=[issue_out(i) for i in issues],
        building=building_out(building),
        access_problems=[access_problem_out(p) for p in access_problems_for(building)],
        stacking_issues=[issue_out(i) for i in stacking_issues(building)] if project.storeys > 1 else [],
        notes=chosen.notes,
        circulation_ratio=chosen.circulation_ratio,
        placement_order=chosen.placement_order,
    )


# ---------------------------------------------------------------- check


class CheckIn(BaseModel):
    project: Project
    arrangement: ArrangementIn


class CheckOut(BaseModel):
    access_problems: list[AccessProblemOut]
    stacking_issues: list[IssueOut]


@app.post("/api/check", response_model=CheckOut)
def check(body: CheckIn) -> CheckOut:
    """The same access and stacking checks the recommendation gets, run on
    whatever the owner has dragged the canvas into."""
    building = building_from_arrangement(body.project, body.arrangement)
    return CheckOut(
        access_problems=[access_problem_out(p) for p in access_problems_for(building)],
        stacking_issues=[issue_out(i) for i in stacking_issues(building)] if body.project.storeys > 1 else [],
    )


# ---------------------------------------------------------------- chat


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatIn(BaseModel):
    history: list[ChatMessage] = Field(description="The whole transcript, ending with the owner's latest message.")
    # What the owner has on the canvas right now, if they've moved things.
    # Passed along to the layout planner so its next suggestion starts
    # from theirs. Not yet used by the prompt; carried so the contract is
    # in place.
    arrangement: ArrangementIn | None = None


class ChatOut(BaseModel):
    assistant_message: str
    explanation: str | None
    project: Project
    layout_plan: LayoutPlan | None


@app.post("/api/chat", response_model=ChatOut)
def chat(body: ChatIn) -> ChatOut:
    """One conversational turn: extract the project from the transcript,
    fill in default storeys, explain any blocking issue, and ask Claude for
    a grouping and adjacency order when there is enough to draw."""
    if not has_api_key():
        raise HTTPException(status_code=503, detail="No ANTHROPIC_API_KEY configured; the chat is disabled.")
    history = [m.model_dump() for m in body.history]
    result = call_claude("Reading your description", lambda: extract_project(history))
    project = assign_default_levels(result.project)

    envelope = envelope_for(project)
    issues = validate_room_program(project, envelope)
    explanation = None
    if any(issue.severity == "error" for issue in issues):
        explanation = call_claude(
            "Explaining the issues",
            lambda: explain_issues(
                json.dumps(project.model_dump(mode="json"), indent=2), project.priorities, issues
            ),
        )

    plan = None
    if envelope is not None and envelope.is_valid and project.rooms:
        plan = call_claude("Grouping the rooms", lambda: plan_layout(project))

    return ChatOut(
        assistant_message=result.assistant_message, explanation=explanation, project=project, layout_plan=plan
    )


# ---------------------------------------------------------------- projects


class ProjectSummary(BaseModel):
    id: str
    name: str
    created_at: str
    updated_at: str


class SavedProjectIn(BaseModel):
    name: str
    project: Project
    layout_plan: LayoutPlan | None = None
    arrangement: ArrangementIn | None = None
    history: list[ChatMessage] = Field(default_factory=list)


class SavedProjectOut(SavedProjectIn):
    id: str
    created_at: str
    updated_at: str


def _saved_out(row: dict[str, Any]) -> SavedProjectOut:
    return SavedProjectOut(**row)


@app.get("/api/projects", response_model=list[ProjectSummary])
def list_projects() -> list[ProjectSummary]:
    return [ProjectSummary(**row) for row in store.list_projects()]


@app.post("/api/projects", response_model=SavedProjectOut)
def create_project(body: SavedProjectIn) -> SavedProjectOut:
    payload = body.model_dump(mode="json", exclude={"name"})
    return _saved_out(store.save_project(body.name, payload))


@app.get("/api/projects/{project_id}", response_model=SavedProjectOut)
def read_project(project_id: str) -> SavedProjectOut:
    row = store.get_project(project_id)
    if row is None:
        raise HTTPException(status_code=404, detail="No such project.")
    return _saved_out(row)


@app.put("/api/projects/{project_id}", response_model=SavedProjectOut)
def update_project(project_id: str, body: SavedProjectIn) -> SavedProjectOut:
    if store.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="No such project.")
    payload = body.model_dump(mode="json", exclude={"name"})
    return _saved_out(store.save_project(body.name, payload, project_id=project_id))


@app.delete("/api/projects/{project_id}", status_code=204)
def remove_project(project_id: str) -> None:
    if not store.delete_project(project_id):
        raise HTTPException(status_code=404, detail="No such project.")


# ---------------------------------------------------------------- frontend

FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"

if FRONTEND_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> FileResponse:
        candidate = FRONTEND_DIST / path
        if path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")

"""The HTTP surface. Run with `uvicorn api.main:app --reload`.

Deliberately thin. The zoning editor runs entirely in the browser
(frontend/); this process exists to serve it and to keep saved layouts.
There is no generation, no checking and no model call behind any route --
the frontend never asks Python for a number.

When frontend/dist exists (the built TypeScript app), it is served at /,
so one process is the whole tool on the owner's computer.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from api import store

app = FastAPI(title="Conceptual Design Engine API", version="0.2.0")

# The Vite dev server runs on another port during development. In the
# built app everything is same-origin and this is moot.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------- health


class HealthOut(BaseModel):
    ok: bool = True


@app.get("/api/health", response_model=HealthOut)
def health() -> HealthOut:
    return HealthOut()


# ---------------------------------------------------------------- layouts


class ProjectSummary(BaseModel):
    id: str
    name: str
    created_at: str
    updated_at: str


class SavedProjectIn(BaseModel):
    """A layout as the canvas holds it. The boxes and door arrows are
    stored exactly as the frontend sends them (plan-frame meters, its own
    field names) and handed back untouched: the browser owns that shape,
    and a copy of it here would only be a second thing to keep in step."""

    name: str
    boxes: list[dict[str, Any]] = Field(default_factory=list)
    arrows: list[dict[str, Any]] = Field(default_factory=list)
    storeys: int = Field(default=1, ge=1)
    # The site boundary, when the layout has one. Optional so that layouts
    # saved before the plot existed still load; the browser opens those
    # with the boundary switched off.
    plot: dict[str, Any] | None = None


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
        raise HTTPException(status_code=404, detail="No such layout.")
    return _saved_out(row)


@app.put("/api/projects/{project_id}", response_model=SavedProjectOut)
def update_project(project_id: str, body: SavedProjectIn) -> SavedProjectOut:
    if store.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="No such layout.")
    payload = body.model_dump(mode="json", exclude={"name"})
    return _saved_out(store.save_project(body.name, payload, project_id=project_id))


@app.delete("/api/projects/{project_id}", status_code=204)
def remove_project(project_id: str) -> None:
    if not store.delete_project(project_id):
        raise HTTPException(status_code=404, detail="No such layout.")


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

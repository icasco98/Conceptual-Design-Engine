"""Saved projects, in a SQLite file next to the code.

One table, one JSON blob per project. That is all the persistence the
tool needs while it runs on one person's computer: no accounts, no
migrations, nothing to administer. The file lives at `data/projects.db`
by default (override with CDE_DB_PATH), and is created on first use.
"""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "projects.db"


def db_path() -> Path:
    return Path(os.environ.get("CDE_DB_PATH", DEFAULT_DB_PATH))


def _connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS projects ("
        " id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL,"
        " created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
    )
    return conn


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def list_projects() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, name, created_at, updated_at FROM projects ORDER BY updated_at DESC"
        ).fetchall()
    return [{"id": r[0], "name": r[1], "created_at": r[2], "updated_at": r[3]} for r in rows]


def get_project(project_id: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, name, body, created_at, updated_at FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
    if row is None:
        return None
    return {"id": row[0], "name": row[1], **json.loads(row[2]), "created_at": row[3], "updated_at": row[4]}


def save_project(name: str, body: dict[str, Any], project_id: str | None = None) -> dict[str, Any]:
    """Insert, or replace when `project_id` names an existing row."""
    now = _now()
    with _connect() as conn:
        if project_id is not None:
            existing = conn.execute("SELECT created_at FROM projects WHERE id = ?", (project_id,)).fetchone()
        else:
            existing = None
        if existing is None:
            project_id = project_id or uuid.uuid4().hex
            conn.execute(
                "INSERT INTO projects (id, name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                (project_id, name, json.dumps(body), now, now),
            )
        else:
            conn.execute(
                "UPDATE projects SET name = ?, body = ?, updated_at = ? WHERE id = ?",
                (name, json.dumps(body), now, project_id),
            )
    saved = get_project(project_id)
    assert saved is not None
    return saved


def delete_project(project_id: str) -> bool:
    with _connect() as conn:
        cursor = conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    return cursor.rowcount > 0

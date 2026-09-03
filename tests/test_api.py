"""The HTTP surface is a thin wrapper over src/; these tests check the
wrapping -- shapes, status codes, persistence -- not the geometry, which
has its own tests."""

import httpx
import pytest
from fastapi.testclient import TestClient

import api.main as api_main
from api import store
from src.sample_project import sample_project


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CDE_DB_PATH", str(tmp_path / "test.db"))
    return TestClient(api_main.app)


def test_health_reports_whether_the_chat_can_work(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert client.get("/api/health").json() == {"ok": True, "has_api_key": False}
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    assert client.get("/api/health").json()["has_api_key"] is True


def test_sample_round_trips_through_the_layout_endpoint(client):
    sample = client.get("/api/sample").json()
    assert sample["project"]["storeys"] == 2

    out = client.post("/api/layout", json=sample).json()
    assert out["envelope"]["valid"] is True
    assert out["issues"] == []
    assert out["access_problems"] == []
    levels = out["building"]["levels"]
    assert [level["level"] for level in levels] == [0, 1]
    names = {room["name"] for level in levels for room in level["rooms"]}
    assert {"Front Entry", "Stair", "Primary Bedroom", "Bathroom 2"} <= names
    assert levels[0]["footprint"]
    assert 0.0 < out["circulation_ratio"] < 0.4


def test_layout_without_a_site_returns_issues_and_no_building(client):
    project = sample_project().model_dump(mode="json")
    project["site"]["edges"] = []
    out = client.post("/api/layout", json={"project": project}).json()
    assert out["building"] is None
    assert out["envelope"] is None


def test_check_runs_access_and_stacking_on_a_hand_made_arrangement(client):
    sample = client.get("/api/sample").json()
    packed = client.post("/api/layout", json=sample).json()["building"]

    # Rebuild the packed plan as an arrangement: clean.
    boxes = [
        {**room, "level": level["level"]}
        for level in packed["levels"]
        for room in level["rooms"]
    ]
    corridors = [{**c, "level": level["level"]} for level in packed["levels"] for c in level["corridors"]]
    body = {"project": sample["project"], "arrangement": {"boxes": boxes, "corridors": corridors}}
    out = client.post("/api/check", json=body).json()
    assert out["access_problems"] == []

    # Drag Bedroom 1 off into the corner on its own: unreachable.
    for box in boxes:
        if box["name"] == "Bedroom 1":
            box["x_m"], box["y_m"] = 0.0, 0.0
    out = client.post("/api/check", json=body).json()
    assert any(p["room_name"] == "Bedroom 1" for p in out["access_problems"])

    # Delete every upstairs stair box: the whole upper level is cut off.
    for box in boxes:
        if box["room_type"] == "stair" and box["level"] == 1:
            box["deleted"] = True
    out = client.post("/api/check", json=body).json()
    assert {"Primary Bedroom", "Bedroom 2"} <= {p["room_name"] for p in out["access_problems"]}


def test_chat_is_refused_without_an_api_key(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    response = client.post("/api/chat", json={"history": [{"role": "user", "content": "hi"}]})
    assert response.status_code == 503


def test_chat_turn_assigns_default_levels_and_plans(client, monkeypatch):
    """Claude is stubbed: the endpoint's own job is to run extraction,
    default the storeys, and plan when there is enough to draw."""
    from src.extraction import ExtractionResult
    from src.models import Project, Room, Site, SiteEdge

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    two_storey = Project(
        site=Site(width_m=14, depth_m=20, edges=[
            SiteEdge(position=p, adjacency="street" if p == "front" else "neighbor")
            for p in ("front", "back", "left", "right")
        ]),
        storeys=2,
        rooms=[
            Room(name="Entry", room_type="entry", is_entry=True),
            Room(name="Stair", room_type="stair"),
            Room(name="Living", room_type="living_room"),
            Room(name="Bedroom", room_type="bedroom", count=2),
            Room(name="Bathroom", room_type="bathroom"),
        ],
    )
    monkeypatch.setattr(
        api_main, "extract_project",
        lambda history: ExtractionResult(project=two_storey, assistant_message="Got it."),
    )
    planned = {}

    def fake_plan(project):
        planned["rooms"] = {r.name: r.levels for r in project.rooms}
        from src.layout_plan import CategoryLabels, LayoutPlan
        return LayoutPlan(
            grouping_label="g", category_labels=CategoryLabels(category_a="A", category_b="B", category_c="C"),
            assignments=[], placement_order=[r.name for r in project.rooms], rationale="r",
        )

    monkeypatch.setattr(api_main, "plan_layout", fake_plan)

    out = client.post("/api/chat", json={"history": [{"role": "user", "content": "two storey house"}]}).json()
    assert out["assistant_message"] == "Got it."
    assert out["explanation"] is None
    by_name = {r["name"]: r["levels"] for r in out["project"]["rooms"]}
    assert by_name["Stair"] == [0, 1]
    assert by_name["Bedroom"] == [1]
    assert by_name["Bathroom"] == [0]
    assert planned["rooms"]["Bedroom"] == [1]
    assert out["layout_plan"]["placement_order"]


def test_projects_are_saved_listed_updated_and_deleted(client):
    sample = client.get("/api/sample").json()
    created = client.post("/api/projects", json={"name": "Our house", **sample}).json()
    assert created["name"] == "Our house"
    assert created["project"]["storeys"] == 2
    pid = created["id"]

    listed = client.get("/api/projects").json()
    assert [p["id"] for p in listed] == [pid]

    updated = client.put(f"/api/projects/{pid}", json={"name": "Renamed", **sample}).json()
    assert updated["name"] == "Renamed"
    assert client.get(f"/api/projects/{pid}").json()["name"] == "Renamed"

    assert client.delete(f"/api/projects/{pid}").status_code == 204
    assert client.get(f"/api/projects/{pid}").status_code == 404
    assert store.list_projects() == []


def test_a_bad_key_reaches_the_owner_as_an_actionable_message(client, monkeypatch):
    """Every Claude failure used to arrive as a bare "Internal Server Error",
    which named nothing the owner could fix."""
    import anthropic

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-nope")

    def refuse(_history):
        raise anthropic.AuthenticationError(
            "invalid x-api-key",
            response=httpx.Response(401, request=httpx.Request("POST", "https://api.anthropic.com")),
            body=None,
        )

    monkeypatch.setattr(api_main, "extract_project", refuse)
    response = client.post("/api/chat", json={"history": [{"role": "user", "content": "hi"}]})
    assert response.status_code == 502
    assert "API key" in response.json()["detail"]


def test_no_credit_is_explained_in_plain_language(client, monkeypatch):
    import anthropic

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")

    def broke(_history):
        raise anthropic.BadRequestError(
            "Your credit balance is too low to access the Anthropic API.",
            response=httpx.Response(400, request=httpx.Request("POST", "https://api.anthropic.com")),
            body=None,
        )

    monkeypatch.setattr(api_main, "extract_project", broke)
    detail = client.post("/api/chat", json={"history": [{"role": "user", "content": "hi"}]}).json()["detail"]
    assert "credit" in detail.lower()
    assert "console.anthropic.com" in detail


def test_an_identity_linked_key_is_told_to_name_its_workspace(client, monkeypatch):
    import anthropic

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")

    def needs_workspace(_history):
        raise anthropic.BadRequestError(
            "anthropic-workspace-id is required when authenticating with an identity-linked "
            "API key; send the id of the workspace this request acts in.",
            response=httpx.Response(400, request=httpx.Request("POST", "https://api.anthropic.com")),
            body=None,
        )

    monkeypatch.setattr(api_main, "extract_project", needs_workspace)
    detail = client.post("/api/chat", json={"history": [{"role": "user", "content": "hi"}]}).json()["detail"]
    assert "ANTHROPIC_WORKSPACE_ID" in detail

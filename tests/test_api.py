"""The HTTP surface is a thin wrapper over the store; these tests check the
wrapping -- shapes, status codes, persistence -- and that a saved layout
comes back exactly as it went in."""

import pytest
from fastapi.testclient import TestClient

import api.main as api_main
from api import store


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CDE_DB_PATH", str(tmp_path / "test.db"))
    return TestClient(api_main.app)


SAMPLE_BOX = {
    "id": "room:0:Kitchen",
    "name": "Kitchen",
    "kind": "room",
    "roomType": "kitchen",
    "isEntry": False,
    "level": 0,
    "left": 2.4,
    "top": 6.5,
    "width": 3.6,
    "height": 3.0,
    "minWidth": 2.7,
    "minHeight": 3.0,
    "rotation": 0,
    "deleted": False,
    "initial": {"left": 2.4, "top": 6.5, "width": 3.6, "height": 3.0},
}


def test_health_is_plain(client):
    assert client.get("/api/health").json() == {"ok": True}


def test_layouts_are_saved_listed_updated_and_deleted(client):
    body = {"name": "Our house", "boxes": [SAMPLE_BOX], "storeys": 2}
    created = client.post("/api/projects", json=body).json()
    assert created["name"] == "Our house"
    assert created["storeys"] == 2
    # The boxes are the frontend's own shape and come back untouched.
    assert created["boxes"] == [SAMPLE_BOX]
    pid = created["id"]

    listed = client.get("/api/projects").json()
    assert [p["id"] for p in listed] == [pid]

    renamed = {**body, "name": "Renamed", "boxes": [{**SAMPLE_BOX, "rotation": 45}]}
    updated = client.put(f"/api/projects/{pid}", json=renamed).json()
    assert updated["name"] == "Renamed"
    fetched = client.get(f"/api/projects/{pid}").json()
    assert fetched["name"] == "Renamed"
    assert fetched["boxes"][0]["rotation"] == 45

    assert client.delete(f"/api/projects/{pid}").status_code == 204
    assert client.get(f"/api/projects/{pid}").status_code == 404
    assert store.list_projects() == []


def test_updating_a_missing_layout_is_a_404(client):
    response = client.put("/api/projects/nope", json={"name": "x", "boxes": [], "storeys": 1})
    assert response.status_code == 404


def test_storeys_must_be_at_least_one(client):
    response = client.post("/api/projects", json={"name": "x", "boxes": [], "storeys": 0})
    assert response.status_code == 422

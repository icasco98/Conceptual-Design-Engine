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


SAMPLE_ARROW = {"id": "arrow:1", "level": 0, "hostId": "room:0:Kitchen", "side": 1, "t": 0.5, "dir": 1}

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
    body = {"name": "Our house", "boxes": [SAMPLE_BOX], "arrows": [SAMPLE_ARROW], "storeys": 2}
    created = client.post("/api/projects", json=body).json()
    assert created["name"] == "Our house"
    assert created["storeys"] == 2
    # Boxes and arrows are the frontend's own shapes, returned untouched.
    assert created["boxes"] == [SAMPLE_BOX]
    assert created["arrows"] == [SAMPLE_ARROW]
    pid = created["id"]

    listed = client.get("/api/projects").json()
    assert [p["id"] for p in listed] == [pid]

    renamed = {**body, "name": "Renamed", "boxes": [{**SAMPLE_BOX, "rotation": 45}]}
    updated = client.put(f"/api/projects/{pid}", json=renamed).json()
    assert updated["name"] == "Renamed"
    fetched = client.get(f"/api/projects/{pid}").json()
    assert fetched["name"] == "Renamed"
    assert fetched["boxes"][0]["rotation"] == 45
    assert fetched["arrows"] == [SAMPLE_ARROW]

    assert client.delete(f"/api/projects/{pid}").status_code == 204
    assert client.get(f"/api/projects/{pid}").status_code == 404
    assert store.list_projects() == []


def test_updating_a_missing_layout_is_a_404(client):
    response = client.put("/api/projects/nope", json={"name": "x", "boxes": [], "arrows": [], "storeys": 1})
    assert response.status_code == 404


def test_storeys_must_be_at_least_one(client):
    response = client.post("/api/projects", json={"name": "x", "boxes": [], "arrows": [], "storeys": 0})
    assert response.status_code == 422


SAMPLE_PLOT = {"on": True, "left": 0, "top": 0, "width": 18.0, "depth": 30.0}


def test_the_plot_is_saved_with_the_layout(client):
    body = {"name": "Corner site", "boxes": [SAMPLE_BOX], "arrows": [], "storeys": 1, "plot": SAMPLE_PLOT}
    pid = client.post("/api/projects", json=body).json()["id"]
    assert client.get(f"/api/projects/{pid}").json()["plot"] == SAMPLE_PLOT


def test_a_layout_saved_before_the_plot_existed_still_loads(client):
    # No plot in the body at all. It comes back as null and the browser
    # opens it with the boundary switched off, exactly as it behaved then.
    body = {"name": "Older layout", "boxes": [SAMPLE_BOX], "arrows": [], "storeys": 1}
    pid = client.post("/api/projects", json=body).json()["id"]
    assert client.get(f"/api/projects/{pid}").json()["plot"] is None

"""
Unit and Integration Tests for HomeDock Settings API.
Tests getting settings, atomic adding and deleting of allowed roots,
auto-creation of directories, and permission checks.
"""

import os
import json
import tempfile
import pytest
from pathlib import Path
from fastapi.testclient import TestClient
from app.main import app
from app.database import init_db, set_setting, get_setting

@pytest.fixture(scope="module", autouse=True)
def setup_env():
    init_db()

@pytest.fixture
def client():
    return TestClient(app)

@pytest.fixture
def admin_headers(client):
    login_resp = client.post("/api/auth/login", json={"username": "admin", "password": "homedock2026!"})
    token = login_resp.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}

def test_get_settings_admin(client, admin_headers):
    resp = client.get("/api/settings", headers=admin_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "global_allowed_roots" in data
    assert "default_download_dir" in data

def test_add_and_remove_allowed_root_atomic(client, admin_headers):
    with tempfile.TemporaryDirectory() as temp_dir:
        new_folder = Path(temp_dir) / "new_media_storage"
        assert not new_folder.exists()

        # Add allowed root (should auto-create directory and persist)
        resp = client.post(
            "/api/settings/allowed-roots",
            json={"path": str(new_folder)},
            headers=admin_headers
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert str(new_folder.resolve()) in data["global_allowed_roots"]
        assert new_folder.exists()

        # Check in GET /api/settings
        get_resp = client.get("/api/settings", headers=admin_headers)
        assert str(new_folder.resolve()) in get_resp.json()["global_allowed_roots"]

        # Delete allowed root
        del_resp = client.delete(
            f"/api/settings/allowed-roots?path={str(new_folder)}",
            headers=admin_headers
        )
        assert del_resp.status_code == 200
        del_data = del_resp.json()
        assert del_data["success"] is True
        assert str(new_folder.resolve()) not in del_data["global_allowed_roots"]

        # Check in GET /api/settings again
        get_resp2 = client.get("/api/settings", headers=admin_headers)
        assert str(new_folder.resolve()) not in get_resp2.json()["global_allowed_roots"]

def test_add_allowed_root_empty_fails(client, admin_headers):
    resp = client.post(
        "/api/settings/allowed-roots",
        json={"path": "   "},
        headers=admin_headers
    )
    assert resp.status_code == 400

def test_update_settings_put(client, admin_headers):
    with tempfile.TemporaryDirectory() as temp_dir:
        dir1 = Path(temp_dir) / "dir1"
        dir2 = Path(temp_dir) / "dir2"

        resp = client.put(
            "/api/settings",
            json={
                "global_allowed_roots": [str(dir1), str(dir2)],
                "default_download_dir": str(dir1)
            },
            headers=admin_headers
        )
        assert resp.status_code == 200
        assert dir1.exists()
        assert dir2.exists()

        data = resp.json()["settings"]
        assert str(dir1.resolve()) in data["global_allowed_roots"]
        assert str(dir2.resolve()) in data["global_allowed_roots"]
        assert data["default_download_dir"] == str(dir1.resolve())

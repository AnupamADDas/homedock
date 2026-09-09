"""
Download Manager Tests for HomeDock.
Tests adding URLs, destination directory boundaries, pause/resume, speed limiting, and deletion.
"""

import pytest
import tempfile
import json
from pathlib import Path
from fastapi.testclient import TestClient
from app.main import app
from app.database import init_db, set_setting
from app.services.download_manager import download_manager

@pytest.fixture(scope="module", autouse=True)
def setup_app():
    init_db()

@pytest.fixture
def test_dir():
    with tempfile.TemporaryDirectory() as td:
        yield td

@pytest.fixture
def auth_headers(client, test_dir):
    from app.database import get_setting
    orig_roots = get_setting("global_allowed_roots", json.dumps(["/DATA/HDD", "/home/asus"]))
    orig_dl = get_setting("default_download_dir", "/DATA/HDD/Downloads")
    set_setting("global_allowed_roots", json.dumps([test_dir, "/DATA", "/DATA/HDD", "/home/asus"]))
    set_setting("default_download_dir", test_dir)
    login_resp = client.post("/api/auth/login", json={"username": "admin", "password": "homedock2026!"})
    token = login_resp.json()["access_token"]
    yield {"Authorization": f"Bearer {token}"}
    set_setting("global_allowed_roots", orig_roots)
    set_setting("default_download_dir", orig_dl)

@pytest.fixture
def client():
    return TestClient(app)

def test_download_stats_endpoint(client, auth_headers):
    resp = client.get("/api/downloads/stats", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "download_speed" in data
    assert "upload_speed" in data
    assert "num_active" in data

def test_add_download_within_allowed_roots(client, auth_headers, test_dir):
    # Use a dummy test URL with pause
    payload = {
        "uris": ["https://httpbin.org/bytes/1024"],
        "destination": test_dir,
        "max_download_limit": 102400,
    }
    resp = client.post("/api/downloads/add", json=payload, headers=auth_headers)
    assert resp.status_code == 200
    gid = resp.json()["gid"]
    assert gid != ""

    # Pause download
    pause_resp = client.post(f"/api/downloads/{gid}/pause", headers=auth_headers)
    assert pause_resp.status_code == 200

    # Clean up download
    del_resp = client.post(f"/api/downloads/{gid}/delete", json={"delete_files": True}, headers=auth_headers)
    assert del_resp.status_code == 200

def test_add_download_outside_allowed_roots_blocked(client, auth_headers):
    # Attempting to download into /root or /etc must be rejected
    payload = {
        "uris": ["https://httpbin.org/bytes/1024"],
        "destination": "/root/downloads"
    }
    resp = client.post("/api/downloads/add", json=payload, headers=auth_headers)
    assert resp.status_code == 403
    assert "outside permitted storage" in resp.json()["detail"].lower()

def test_global_speed_limits_endpoint(client, auth_headers):
    resp = client.post("/api/downloads/global-limits", json={"download_limit": 1048576, "upload_limit": 524288}, headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["success"] is True

    # Reset back to 0 (unlimited) so test does not pollute production runtime
    reset_resp = client.post("/api/downloads/global-limits", json={"download_limit": 0, "upload_limit": 0}, headers=auth_headers)
    assert reset_resp.status_code == 200
    assert reset_resp.json()["success"] is True

def test_task_speed_limit_and_reset(client, auth_headers, test_dir):
    payload = {
        "uris": ["https://httpbin.org/bytes/1024"],
        "destination": test_dir,
    }
    resp = client.post("/api/downloads/add", json=payload, headers=auth_headers)
    assert resp.status_code == 200
    gid = resp.json()["gid"]
    assert gid != ""

    # Pause download first to prevent early exit
    client.post(f"/api/downloads/{gid}/pause", headers=auth_headers)

    # Set per-task speed limit
    lim_resp = client.post(f"/api/downloads/{gid}/limit", json={"limit_bytes_sec": 512000}, headers=auth_headers)
    assert lim_resp.status_code == 200
    assert lim_resp.json()["success"] is True

    # Check list has speed limit
    list_resp = client.get("/api/downloads/list", headers=auth_headers)
    assert list_resp.status_code == 200
    item = next((d for d in list_resp.json() if d["gid"] == gid), None)
    assert item is not None
    assert item["max_download_limit"] == 512000

    # Reset speed limit to 0 (unlimited)
    unlim_resp = client.post(f"/api/downloads/{gid}/limit", json={"limit_bytes_sec": 0}, headers=auth_headers)
    assert unlim_resp.status_code == 200
    assert unlim_resp.json()["success"] is True

    # Verify reset in list
    list_resp2 = client.get("/api/downloads/list", headers=auth_headers)
    assert list_resp2.status_code == 200
    item2 = next((d for d in list_resp2.json() if d["gid"] == gid), None)
    assert item2 is not None
    assert item2["max_download_limit"] == 0

    # Delete download
    client.post(f"/api/downloads/{gid}/delete", json={"delete_files": True}, headers=auth_headers)


def test_default_download_dir_endpoints(client, auth_headers, test_dir):
    from app.database import get_setting

    # 1. GET /api/downloads/default-dir
    resp = client.get("/api/downloads/default-dir", headers=auth_headers)
    assert resp.status_code == 200
    assert "default_dir" in resp.json()

    # 2. PUT /api/downloads/default-dir with valid directory inside allowed roots
    new_sub = Path(test_dir) / "sub_download"
    put_resp = client.put(
        "/api/downloads/default-dir",
        json={"default_dir": str(new_sub)},
        headers=auth_headers
    )
    assert put_resp.status_code == 200
    assert put_resp.json()["success"] is True
    assert put_resp.json()["default_dir"] == str(new_sub.resolve())
    assert get_setting("default_download_dir") == str(new_sub.resolve())

    # 3. PUT /api/downloads/default-dir outside allowed roots fails
    bad_resp = client.put(
        "/api/downloads/default-dir",
        json={"default_dir": "/root/forbidden_dl"},
        headers=auth_headers
    )
    assert bad_resp.status_code == 400

    # 4. Adding download with save_as_default=True updates default_download_dir
    another_sub = Path(test_dir) / "another_dl"
    add_resp = client.post(
        "/api/downloads/add",
        json={
            "uris": ["https://httpbin.org/bytes/1024"],
            "destination": str(another_sub),
            "save_as_default": True
        },
        headers=auth_headers
    )
    assert add_resp.status_code == 200
    gid = add_resp.json()["gid"]
    assert get_setting("default_download_dir") == str(another_sub.resolve())

    # Clean up download
    client.post(f"/api/downloads/{gid}/delete", json={"delete_files": True}, headers=auth_headers)



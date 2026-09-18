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
    home_dir = str(Path.home().resolve())
    orig_roots = get_setting("global_allowed_roots", json.dumps([home_dir]))
    orig_dl = get_setting("default_download_dir", str(Path.home() / "Downloads"))
    set_setting("global_allowed_roots", json.dumps([test_dir, home_dir]))
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


def test_youtube_probe_mocked(client, auth_headers):
    from unittest.mock import patch, AsyncMock
    from app.services.youtube_downloader import youtube_downloader

    mock_info = {
        "title": "Rick Astley - Never Gonna Give You Up",
        "uploader": "RickAstleyVEVO",
        "duration": 213,
        "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
        "resolutions": [1080, 720, 480, 360],
        "is_playlist": False,
        "playlist_count": 0
    }

    with patch.object(youtube_downloader, "probe_url", new_callable=AsyncMock) as mock_probe:
        mock_probe.return_value = mock_info
        resp = client.post(
            "/api/downloads/youtube/probe",
            json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
            headers=auth_headers
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["title"] == "Rick Astley - Never Gonna Give You Up"
        assert data["resolutions"] == [1080, 720, 480, 360]
        assert data["duration"] == 213


def test_youtube_add_outside_allowed_roots_blocked(client, auth_headers):
    from unittest.mock import patch, AsyncMock
    from app.services.youtube_downloader import youtube_downloader

    payload = {
        "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "destination_dir": "/root/forbidden_media",
        "media_type": "video"
    }
    with patch.object(youtube_downloader, "_run_download_task", new_callable=AsyncMock):
        resp = client.post("/api/downloads/youtube/add", json=payload, headers=auth_headers)
        assert resp.status_code == 403
        assert "outside permitted storage" in resp.json()["detail"].lower()


def test_youtube_add_video_and_audio_downloads(client, auth_headers, test_dir):
    from unittest.mock import patch, AsyncMock
    from app.services.youtube_downloader import youtube_downloader

    # 1. Add video task
    video_payload = {
        "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "destination_dir": test_dir,
        "media_type": "video",
        "resolution": "1080",
        "video_format": "mp4",
        "embed_thumbnail": True,
        "embed_metadata": True,
        "embed_subtitles": False
    }

    with patch.object(youtube_downloader, "_run_download_task", new_callable=AsyncMock):
        v_resp = client.post("/api/downloads/youtube/add", json=video_payload, headers=auth_headers)
        assert v_resp.status_code == 200
        v_data = v_resp.json()
        v_gid = v_data["gid"]
        assert v_gid.startswith("yt-")

        # 2. Add audio task
        audio_payload = {
            "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "destination_dir": test_dir,
            "media_type": "audio",
            "audio_format": "mp3",
            "audio_quality": "320",
            "embed_thumbnail": True,
            "embed_metadata": True
        }
        a_resp = client.post("/api/downloads/youtube/add", json=audio_payload, headers=auth_headers)
        assert a_resp.status_code == 200
        a_data = a_resp.json()
        a_gid = a_data["gid"]
        assert a_gid.startswith("yt-")

        # 3. Check /api/downloads/list returns both YouTube tasks
        list_resp = client.get("/api/downloads/list", headers=auth_headers)
        assert list_resp.status_code == 200
        items = list_resp.json()
        v_item = next((i for i in items if i["gid"] == v_gid), None)
        a_item = next((i for i in items if i["gid"] == a_gid), None)

        assert v_item is not None
        assert v_item["is_youtube"] is True
        assert v_item["media_type"] == "video"
        assert v_item["quality"] == "1080"
        assert v_item["format_id"] == "mp4"

        assert a_item is not None
        assert a_item["is_youtube"] is True
        assert a_item["media_type"] == "audio"
        assert a_item["quality"] == "320"
        assert a_item["format_id"] == "mp3"

        # 4. Clean up tasks via unified delete endpoint
        client.post(f"/api/downloads/{v_gid}/delete", json={"delete_files": True}, headers=auth_headers)
        client.post(f"/api/downloads/{a_gid}/delete", json={"delete_files": True}, headers=auth_headers)




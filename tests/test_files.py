"""
Comprehensive Filesystem & Security Tests for HomeDock.
Tests upload, download, rename, copy, move, delete, path traversal attacks,
symlink breakout attempts, and malicious archive extraction prevention.
"""

import os
import io
import zipfile
import tarfile
import tempfile
import pytest
from pathlib import Path
from fastapi.testclient import TestClient
from app.main import app
from app.database import init_db, set_setting
from app.services.file_service import file_service

@pytest.fixture(scope="module", autouse=True)
def setup_env():
    init_db()

@pytest.fixture
def test_sandbox():
    with tempfile.TemporaryDirectory() as temp_dir:
        # Create allowed root structure
        allowed_dir = Path(temp_dir) / "allowed"
        allowed_dir.mkdir(parents=True, exist_ok=True)
        
        # Outside target
        outside_dir = Path(temp_dir) / "secret"
        outside_dir.mkdir(parents=True, exist_ok=True)
        secret_file = outside_dir / "secret.txt"
        secret_file.write_text("classified_information")

        yield {
            "allowed": str(allowed_dir),
            "outside": str(outside_dir),
            "secret_file": str(secret_file),
        }

@pytest.fixture
def auth_headers(client, test_sandbox):
    # Register sandbox allowed root in database settings and restore on teardown
    import json
    from app.database import get_setting
    orig_roots = get_setting("global_allowed_roots", json.dumps([str(Path.home().resolve())]))
    set_setting("global_allowed_roots", json.dumps([test_sandbox["allowed"]]))

    login_resp = client.post("/api/auth/login", json={"username": "admin", "password": "homedock2026!"})
    token = login_resp.json()["access_token"]
    yield {"Authorization": f"Bearer {token}"}
    set_setting("global_allowed_roots", orig_roots)

@pytest.fixture
def client():
    return TestClient(app)

def test_file_upload_and_download(client, auth_headers, test_sandbox):
    allowed = test_sandbox["allowed"]
    test_content = b"HomeDock secure file content 12345"

    # Upload
    files = {"file": ("test_upload.txt", io.BytesIO(test_content), "text/plain")}
    data = {"destination": allowed}
    upload_resp = client.post("/api/files/upload", data=data, files=files, headers=auth_headers)
    assert upload_resp.status_code == 200
    uploaded_path = upload_resp.json()["path"]
    assert os.path.exists(uploaded_path)

    # Download
    dl_resp = client.get(f"/api/files/download?path={uploaded_path}", headers=auth_headers)
    assert dl_resp.status_code == 200
    assert dl_resp.content == test_content

def test_path_traversal_blocked(client, auth_headers, test_sandbox):
    # 1. Direct outside file
    outside_file = test_sandbox["secret_file"]
    resp = client.get(f"/api/files/download?path={outside_file}", headers=auth_headers)
    assert resp.status_code == 403

    # 2. Path traversal sequence ../..
    traversal_path = f"{test_sandbox['allowed']}/../../etc/passwd"
    resp2 = client.get(f"/api/files/download?path={traversal_path}", headers=auth_headers)
    assert resp2.status_code in (403, 404)

def test_symlink_breakout_blocked(client, auth_headers, test_sandbox):
    allowed = test_sandbox["allowed"]
    secret_file = test_sandbox["secret_file"]
    symlink_path = os.path.join(allowed, "evil_symlink.txt")
    
    # Create symlink inside allowed root pointing outside
    try:
        os.symlink(secret_file, symlink_path)
    except OSError:
        pytest.skip("Symlink creation not supported on this filesystem")

    # Attempting to access file through symlink must be blocked by resolve validation
    resp = client.get(f"/api/files/download?path={symlink_path}", headers=auth_headers)
    assert resp.status_code == 403

def test_directory_crud_operations(client, auth_headers, test_sandbox):
    allowed = test_sandbox["allowed"]
    
    # Create directory
    new_dir = os.path.join(allowed, "test_folder")
    mkdir_resp = client.post("/api/files/mkdir", json={"path": new_dir}, headers=auth_headers)
    assert mkdir_resp.status_code == 200
    assert os.path.isdir(new_dir)

    # Create dummy file inside
    sample_file = os.path.join(new_dir, "item.txt")
    with open(sample_file, "w") as f:
        f.write("content")

    # Rename
    rename_resp = client.post("/api/files/rename", json={"source": sample_file, "new_name": "renamed.txt"}, headers=auth_headers)
    assert rename_resp.status_code == 200
    assert os.path.exists(os.path.join(new_dir, "renamed.txt"))

    # Copy
    copy_resp = client.post("/api/files/copy", json={
        "sources": [os.path.join(new_dir, "renamed.txt")],
        "destination": allowed
    }, headers=auth_headers)
    assert copy_resp.status_code == 200
    assert os.path.exists(os.path.join(allowed, "renamed.txt"))

    # Move
    move_target = os.path.join(allowed, "renamed.txt")
    sub_dir = os.path.join(new_dir, "sub")
    os.makedirs(sub_dir, exist_ok=True)
    move_resp = client.post("/api/files/move", json={
        "sources": [move_target],
        "destination": sub_dir
    }, headers=auth_headers)
    assert move_resp.status_code == 200
    assert os.path.exists(os.path.join(sub_dir, "renamed.txt"))
    assert not os.path.exists(move_target)

    # Delete
    del_resp = client.post("/api/files/delete", json={
        "paths": [new_dir]
    }, headers=auth_headers)
    assert del_resp.status_code == 200
    assert not os.path.exists(new_dir)

def test_malicious_archive_traversal_blocked(client, auth_headers, test_sandbox):
    allowed = test_sandbox["allowed"]
    zip_path = os.path.join(allowed, "malicious.zip")

    # Create a zip file containing ../ traversal attempt
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("../../evil.txt", "pwned")

    # Attempt to extract
    extract_resp = client.post("/api/files/extract", json={"archive_path": zip_path}, headers=auth_headers)
    assert extract_resp.status_code == 403
    assert "malicious" in extract_resp.json()["detail"].lower()

def test_safe_archive_extraction(client, auth_headers, test_sandbox):
    allowed = test_sandbox["allowed"]
    zip_path = os.path.join(allowed, "safe.zip")

    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("safe_dir/file1.txt", "Safe Content 1")
        zf.writestr("safe_dir/file2.txt", "Safe Content 2")

    extract_resp = client.post("/api/files/extract", json={"archive_path": zip_path}, headers=auth_headers)
    assert extract_resp.status_code == 200
    assert extract_resp.json()["files_extracted"] == 2
    assert os.path.exists(os.path.join(allowed, "safe_extracted", "safe_dir", "file1.txt"))

def test_task_progress_tracking_copy_and_move(client, auth_headers, test_sandbox):
    allowed = test_sandbox["allowed"]
    src_file = os.path.join(allowed, "source_progress.txt")
    with open(src_file, "w") as f:
        f.write("HomeDock progress tracking " * 100)

    # 1. Copy with task_id
    task_id_copy = "test-copy-task-123"
    copy_resp = client.post("/api/files/copy", json={
        "sources": [src_file],
        "destination": allowed,
        "task_id": task_id_copy
    }, headers=auth_headers)
    assert copy_resp.status_code == 200
    assert copy_resp.json()["task_id"] == task_id_copy

    # Query task status
    task_resp = client.get(f"/api/files/tasks/{task_id_copy}", headers=auth_headers)
    assert task_resp.status_code == 200
    task_data = task_resp.json()["task"]
    assert task_data["task_id"] == task_id_copy
    assert task_data["status"] == "completed"
    assert task_data["percent"] == 100.0

    # 2. Move with task_id
    dest_subdir = os.path.join(allowed, "progress_sub")
    os.makedirs(dest_subdir, exist_ok=True)
    task_id_move = "test-move-task-456"
    move_resp = client.post("/api/files/move", json={
        "sources": [src_file],
        "destination": dest_subdir,
        "task_id": task_id_move
    }, headers=auth_headers)
    assert move_resp.status_code == 200
    assert move_resp.json()["task_id"] == task_id_move

    # Query task status
    task_move_resp = client.get(f"/api/files/tasks/{task_id_move}", headers=auth_headers)
    assert task_move_resp.status_code == 200
    task_move_data = task_move_resp.json()["task"]
    assert task_move_data["task_id"] == task_id_move
    assert task_move_data["status"] == "completed"
    assert task_move_data["percent"] == 100.0

def test_task_progress_tracking_extract(client, auth_headers, test_sandbox):
    allowed = test_sandbox["allowed"]
    zip_path = os.path.join(allowed, "progress_extract.zip")
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("sub/doc1.txt", "Doc 1 content")
        zf.writestr("sub/doc2.txt", "Doc 2 content")

    task_id_extract = "test-extract-task-789"
    extract_resp = client.post("/api/files/extract", json={
        "archive_path": zip_path,
        "task_id": task_id_extract
    }, headers=auth_headers)
    assert extract_resp.status_code == 200
    assert extract_resp.json()["files_extracted"] == 2

    # Query task status
    task_resp = client.get(f"/api/files/tasks/{task_id_extract}", headers=auth_headers)
    assert task_resp.status_code == 200
    task_data = task_resp.json()["task"]
    assert task_data["task_id"] == task_id_extract
    assert task_data["status"] == "completed"
    assert task_data["percent"] == 100.0

def test_task_cancellation_endpoint(client, auth_headers, test_sandbox):
    from app.services.task_manager import task_manager
    task_id = "test-cancel-sample-111"
    task_manager.create_task(task_id, "copy", "Test copy cancellation")
    assert task_manager.is_cancelled(task_id) is False

    cancel_resp = client.post(f"/api/files/tasks/{task_id}/cancel", headers=auth_headers)
    assert cancel_resp.status_code == 200
    assert cancel_resp.json()["status"] == "cancelled"
    assert task_manager.is_cancelled(task_id) is True

    # Query task status
    task_resp = client.get(f"/api/files/tasks/{task_id}", headers=auth_headers)
    assert task_resp.status_code == 200
    task_data = task_resp.json()["task"]
    assert task_data["status"] == "cancelled"

def test_browse_folders_endpoint(client, auth_headers, test_sandbox):
    allowed = test_sandbox["allowed"]
    # Create subfolders inside allowed
    sub1 = Path(allowed) / "subfolder1"
    sub2 = Path(allowed) / "subfolder2"
    sub1.mkdir(parents=True, exist_ok=True)
    sub2.mkdir(parents=True, exist_ok=True)

    resp = client.get(f"/api/files/browse-folders?path={allowed}", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "current_path" in data
    assert "breadcrumbs" in data
    assert "quick_locations" in data
    assert "directories" in data
    dir_names = [d["name"] for d in data["directories"]]
    assert "subfolder1" in dir_names
    assert "subfolder2" in dir_names

def test_root_filesystem_allowed():
    from app.services.file_service import file_service
    roots = ["/"]
    assert file_service.validate_path("/", roots) == Path("/")
    assert file_service.validate_path("/home", roots) == Path("/home")
    assert file_service.validate_path(str(Path.home()), roots) == Path.home().resolve()

    dir_data = file_service.list_directory(Path("/home"), roots)
    assert dir_data["current_path"] == "/home"
    assert dir_data["parent_path"] == "/"
    crumb_paths = [c["path"] for c in dir_data["breadcrumbs"]]
    assert "/" in crumb_paths
    assert "/home" in crumb_paths




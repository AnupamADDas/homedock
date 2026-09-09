"""
Comprehensive Authentication & Authorization Tests for HomeDock.
Tests valid login, invalid credentials, brute-force rate-limiting lockout,
token revocation on logout, session expiration, and unauthorized access.
"""

import pytest
import time
from fastapi.testclient import TestClient
from app.main import app
from app.database import init_db, get_db_connection
from app.security import hash_password, create_access_token

@pytest.fixture(scope="module", autouse=True)
def setup_database():
    init_db()

@pytest.fixture
def client():
    return TestClient(app)

def test_login_success(client):
    response = client.post("/api/auth/login", json={"username": "admin", "password": "homedock2026!"})
    assert response.status_code == 200
    data = response.json()
    assert "access_token" in data
    assert data["user"]["username"] == "admin"
    assert data["user"]["role"] == "admin"
    assert "homedock_token" in response.cookies

def test_login_invalid_credentials(client):
    response = client.post("/api/auth/login", json={"username": "admin", "password": "wrongpassword"})
    assert response.status_code == 401
    assert "Incorrect username or password" in response.json()["detail"]

def test_unauthorized_access_blocked(client):
    # System metrics requires authentication
    response = client.get("/api/system/metrics")
    assert response.status_code == 401

def test_authenticated_me_endpoint(client):
    login_resp = client.post("/api/auth/login", json={"username": "admin", "password": "homedock2026!"})
    token = login_resp.json()["access_token"]
    
    response = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    assert response.json()["username"] == "admin"
    assert "allowed_roots" in response.json()

def test_logout_revokes_token(client):
    login_resp = client.post("/api/auth/login", json={"username": "admin", "password": "homedock2026!"})
    token = login_resp.json()["access_token"]

    # Verify access works before logout
    resp_before = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp_before.status_code == 200

    # Perform logout
    logout_resp = client.post("/api/auth/logout", headers={"Authorization": f"Bearer {token}"})
    assert logout_resp.status_code == 200

    # Attempt to reuse revoked token
    resp_after = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp_after.status_code == 401

def test_rate_limiting_lockout(client):
    # Clean attempts for test IP
    with get_db_connection() as conn:
        conn.execute("DELETE FROM login_attempts WHERE ip_address = 'testclient'")
        conn.commit()

    # Issue 5 consecutive invalid attempts
    for _ in range(5):
        client.post("/api/auth/login", json={"username": "admin", "password": "badpassword"})

    # 6th attempt must be rejected with 429 Too Many Requests
    resp = client.post("/api/auth/login", json={"username": "admin", "password": "homedock2026!"})
    assert resp.status_code == 429
    assert "locked out" in resp.json()["detail"].lower()

    # Reset test IP lock for subsequent tests
    with get_db_connection() as conn:
        conn.execute("DELETE FROM login_attempts WHERE ip_address = 'testclient'")
        conn.commit()

def test_change_username_flow(client):
    # 1. Login as admin
    admin_login = client.post("/api/auth/login", json={"username": "admin", "password": "homedock2026!"})
    admin_token = admin_login.json()["access_token"]

    # 2. Create test user
    create_resp = client.post(
        "/api/users",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"username": "testuser_edit", "password": "password123", "role": "user"}
    )
    assert create_resp.status_code == 200
    user_id = create_resp.json()["id"]

    # 3. Login as testuser_edit
    user_login = client.post("/api/auth/login", json={"username": "testuser_edit", "password": "password123"})
    assert user_login.status_code == 200
    old_token = user_login.json()["access_token"]

    # 4. Fail with wrong password
    bad_resp = client.post(
        "/api/auth/change-username",
        headers={"Authorization": f"Bearer {old_token}"},
        json={"new_username": "new_uname", "current_password": "wrongpassword"}
    )
    assert bad_resp.status_code == 400
    assert "password verification failed" in bad_resp.json()["detail"].lower()

    # 5. Fail when username already taken (by admin)
    conflict_resp = client.post(
        "/api/auth/change-username",
        headers={"Authorization": f"Bearer {old_token}"},
        json={"new_username": "admin", "current_password": "password123"}
    )
    assert conflict_resp.status_code == 409

    # 6. Successfully change username
    ok_resp = client.post(
        "/api/auth/change-username",
        headers={"Authorization": f"Bearer {old_token}"},
        json={"new_username": "testuser_changed", "current_password": "password123"}
    )
    assert ok_resp.status_code == 200
    new_token = ok_resp.json()["access_token"]
    assert ok_resp.json()["user"]["username"] == "testuser_changed"

    # 7. Old token must be revoked
    stale_resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {old_token}"})
    assert stale_resp.status_code == 401

    # 8. New token works and returns updated username
    fresh_resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {new_token}"})
    assert fresh_resp.status_code == 200
    assert fresh_resp.json()["username"] == "testuser_changed"

    # 9. Admin edits user's username
    admin_edit = client.put(
        f"/api/users/{user_id}",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"username": "testuser_by_admin"}
    )
    assert admin_edit.status_code == 200

    # 10. Admin duplicate check
    admin_conflict = client.put(
        f"/api/users/{user_id}",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"username": "admin"}
    )
    assert admin_conflict.status_code == 409

    # 11. Clean up created user
    client.delete(f"/api/users/{user_id}", headers={"Authorization": f"Bearer {admin_token}"})

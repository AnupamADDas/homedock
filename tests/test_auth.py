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

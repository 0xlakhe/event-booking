"""Auth lifecycle tests against isolated PostgreSQL (TASK-003).

Exercises the HTTP interface: registration validation and role safety,
login/token mechanics, expiry and logout revocation, and the admin
permission dependency. Session expiry is arranged with database fixture
updates, never clock overrides.
"""

import hashlib
import os
import time
import uuid

import psycopg
import pytest
from fastapi import Depends
from fastapi.testclient import TestClient

from app.auth import require_admin
from app.config import Settings
from app.main import create_app
from app.passwords import hash_password


def _strip(url: str) -> str:
    return url.replace("+psycopg://", "://")


def _email() -> str:
    return f"auth-{uuid.uuid4().hex[:12]}@example.com"


@pytest.fixture(scope="module")
def api() -> TestClient:
    settings = Settings(
        DATABASE_URL=os.environ["TEST_DATABASE_URL"],
        EXPECTED_ALEMBIC_REVISION=None,
    )
    app = create_app(settings)

    @app.get("/_test/admin-ping")
    def _admin_ping(actor=Depends(require_admin)):  # type: ignore[no-untyped-def]
        return {"ok": True, "role": actor.role}

    return TestClient(app)


@pytest.fixture()
def migrator_conn(clean_db: dict[str, str]):  # type: ignore[no-untyped-def]
    with psycopg.connect(_strip(clean_db["migration_url"])) as conn:
        yield conn
        conn.rollback()


def _register(api: TestClient, email: str, password: str = "password-123") -> dict:
    resp = api.post("/api/auth/register", json={"email": email, "password": password})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _login(api: TestClient, email: str, password: str = "password-123") -> dict:
    resp = api.post("/api/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _rate_limited_client(attempts: int, window_seconds: int = 60) -> TestClient:
    settings = Settings(
        DATABASE_URL=os.environ["TEST_DATABASE_URL"],
        EXPECTED_ALEMBIC_REVISION=None,
        LOGIN_RATE_LIMIT_ATTEMPTS=attempts,
        LOGIN_RATE_LIMIT_WINDOW_SECONDS=window_seconds,
    )
    return TestClient(create_app(settings))


def test_non_ascii_bearer_token_is_controlled_401(
    clean_db: dict[str, str], api: TestClient
) -> None:
    _ = clean_db
    # Raw header bytes, as a real client would send them: Starlette decodes
    # latin-1, yielding a str that can never be an issued ASCII token.
    raw: list[tuple[bytes, bytes]] = [
        (b"authorization", "Bearer tökén-ÿþ".encode("latin-1"))
    ]
    resp = api.get("/api/auth/me", headers=raw)  # type: ignore[arg-type]
    assert resp.status_code == 401, resp.text
    assert resp.json()["error"]["code"] == "INVALID_SESSION"
    assert resp.headers.get("www-authenticate") == "Bearer"


def test_login_database_outage_returns_503_envelope(
    clean_db: dict[str, str],
) -> None:
    _ = clean_db
    settings = Settings(
        DATABASE_URL="postgresql+psycopg://u:p@db:5999/eventbook_test",
        DB_CONNECT_TIMEOUT=1,
        EXPECTED_ALEMBIC_REVISION=None,
    )
    client = TestClient(create_app(settings))
    login = client.post(
        "/api/auth/login", json={"email": "any@example.com", "password": "password-123"}
    )
    assert login.status_code == 503, login.text
    assert login.json() == {
        "error": {"code": "TEMPORARILY_UNAVAILABLE", "message": "Service temporarily unavailable."}
    }
    assert "application/json" in login.headers.get("content-type", "")
    me = client.get("/api/auth/me", headers={"Authorization": "Bearer anything"})
    assert me.status_code == 503, me.text
    assert me.json()["error"]["code"] == "TEMPORARILY_UNAVAILABLE"


def test_private_responses_are_not_storeable(
    clean_db: dict[str, str], api: TestClient
) -> None:
    _ = clean_db
    email = _email()
    _register(api, email)
    login = api.post("/api/auth/login", json={"email": email, "password": "password-123"})
    assert login.status_code == 200, login.text
    assert login.headers.get("cache-control") == "no-store"
    me = api.get("/api/auth/me", headers=_auth(login.json()["access_token"]))
    assert me.status_code == 200, me.text
    assert me.headers.get("cache-control") == "no-store"


def test_auth_error_responses_are_not_storeable(
    clean_db: dict[str, str], api: TestClient
) -> None:
    _ = clean_db
    assert api.get("/api/auth/me").headers.get("cache-control") == "no-store"
    bad = api.post("/api/auth/register", json={"email": "x", "password": "short"})
    assert bad.status_code == 422
    assert bad.headers.get("cache-control") == "no-store"
    email = _email()
    _register(api, email)
    dup = api.post(
        "/api/auth/register", json={"email": email, "password": "password-123"}
    )
    assert dup.status_code == 409
    assert dup.headers.get("cache-control") == "no-store"
    token = _login(api, email)["access_token"]
    out = api.post("/api/auth/logout", headers=_auth(token))
    assert out.status_code == 204
    assert out.headers.get("cache-control") == "no-store"


def test_outage_response_is_not_storeable(clean_db: dict[str, str]) -> None:
    _ = clean_db
    settings = Settings(
        DATABASE_URL="postgresql+psycopg://u:p@db:5999/eventbook_test",
        DB_CONNECT_TIMEOUT=1,
        EXPECTED_ALEMBIC_REVISION=None,
    )
    client = TestClient(create_app(settings))
    resp = client.post(
        "/api/auth/login", json={"email": "any@example.com", "password": "password-123"}
    )
    assert resp.status_code == 503
    assert resp.headers.get("cache-control") == "no-store"


def test_database_error_handler_logs_no_parameters(caplog: pytest.LogCaptureFixture) -> None:
    import asyncio
    import logging

    from sqlalchemy.exc import OperationalError

    from app.errors import database_error_handler

    marker = "SENSITIVE-HASH-MARKER-abc123"
    exc = OperationalError(
        "INSERT INTO eventbook.users (email, password_hash) VALUES (%s, %s)",
        {"email": marker, "hash": marker},
        Exception("connection refused"),
    )
    with caplog.at_level(logging.ERROR, logger="eventbook"):
        resp = asyncio.run(database_error_handler(None, exc))  # type: ignore[arg-type]
    import json as _json

    assert resp.status_code == 503
    assert _json.loads(resp.body)["error"]["code"] == "TEMPORARILY_UNAVAILABLE"
    assert marker not in caplog.text
    assert "OperationalError" in caplog.text


def test_register_login_me_lifecycle(clean_db: dict[str, str], api: TestClient) -> None:
    _ = clean_db
    email = _email()
    user = _register(api, email)
    assert set(user) == {"id", "email", "role"}
    assert user["email"] == email and user["role"] == "user"
    assert "password_hash" not in user and "password" not in str(user)

    session = _login(api, email)
    assert session["token_type"] == "bearer"
    assert session["expires_at"].endswith("Z")
    assert session["user"]["email"] == email

    me = api.get("/api/auth/me", headers=_auth(session["access_token"]))
    assert me.status_code == 200, me.text
    assert me.json() == user


def test_register_normalizes_email_and_rejects_duplicate(
    clean_db: dict[str, str], api: TestClient
) -> None:
    _ = clean_db
    _register(api, "  MiXeD-Case@Example.COM  ")
    dup = api.post(
        "/api/auth/register", json={"email": "mixed-case@example.com", "password": "password-123"}
    )
    assert dup.status_code == 409
    assert dup.json() == {
        "error": {"code": "EMAIL_EXISTS", "message": "An account with this email already exists."}
    }
    me_token = _login(api, "MIXED-case@example.com")["access_token"]
    assert api.get("/api/auth/me", headers=_auth(me_token)).status_code == 200


def test_register_rejects_role_and_unknown_fields(
    clean_db: dict[str, str], api: TestClient
) -> None:
    _ = clean_db
    for body in (
        {"email": _email(), "password": "password-123", "role": "admin"},
        {"email": _email(), "password": "password-123", "nickname": "x"},
    ):
        resp = api.post("/api/auth/register", json=body)
        assert resp.status_code == 422, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    assert "password-123" not in resp.text


def test_register_validation_errors_are_sanitized(
    clean_db: dict[str, str], api: TestClient
) -> None:
    _ = clean_db
    secret = "s3cret-pw-9"
    cases = [
        {"email": "not-an-email", "password": secret},
        {"email": _email(), "password": "short"},
        {"email": _email()},
    ]
    for body in cases:
        resp = api.post("/api/auth/register", json=body)
        assert resp.status_code == 422, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
        assert secret not in resp.text


def test_password_stored_argon2id(
    clean_db: dict[str, str], api: TestClient, migrator_conn: psycopg.Connection
) -> None:
    _ = clean_db
    email = _email()
    _register(api, email, password="Unique-Pass-456")
    row = migrator_conn.execute(
        "SELECT password_hash FROM eventbook.users WHERE email = %s", (email,)
    ).fetchone()
    assert row is not None
    assert row[0].startswith("$argon2id$")
    assert "Unique-Pass-456" not in row[0]


def test_login_failures_are_generic(
    clean_db: dict[str, str], api: TestClient
) -> None:
    _ = clean_db
    email = _email()
    _register(api, email)
    unknown = api.post(
        "/api/auth/login", json={"email": _email(), "password": "password-123"}
    )
    wrong = api.post("/api/auth/login", json={"email": email, "password": "wrong-pass-1"})
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json() == wrong.json()
    assert unknown.json()["error"]["code"] == "INVALID_CREDENTIALS"
    assert unknown.headers.get("www-authenticate") == "Bearer"


def test_token_returned_once_and_stored_hashed(
    clean_db: dict[str, str], api: TestClient, migrator_conn: psycopg.Connection
) -> None:
    _ = clean_db
    email = _email()
    _register(api, email)
    raw = _login(api, email)["access_token"]
    row = migrator_conn.execute(
        "SELECT token_hash FROM eventbook.sessions s "
        "JOIN eventbook.users u ON u.id = s.user_id WHERE u.email = %s",
        (email,),
    ).fetchone()
    assert row is not None
    assert row[0] == hashlib.sha256(raw.encode("ascii")).hexdigest()
    assert row[0] != raw


def test_expired_session_rejected(
    clean_db: dict[str, str], api: TestClient, migrator_conn: psycopg.Connection
) -> None:
    _ = clean_db
    email = _email()
    _register(api, email)
    raw = _login(api, email)["access_token"]
    migrator_conn.execute(
        "UPDATE eventbook.sessions SET created_at = now() - interval '2 hours', "
        "expires_at = now() - interval '1 hour' WHERE token_hash = %s",
        (hashlib.sha256(raw.encode("ascii")).hexdigest(),),
    )
    migrator_conn.commit()
    me = api.get("/api/auth/me", headers=_auth(raw))
    assert me.status_code == 401
    assert me.json()["error"]["code"] == "INVALID_SESSION"
    assert _login(api, email)["access_token"] != raw


def test_logout_invalidates_session(clean_db: dict[str, str], api: TestClient) -> None:
    _ = clean_db
    email = _email()
    _register(api, email)
    raw = _login(api, email)["access_token"]
    headers = _auth(raw)
    assert api.post("/api/auth/logout", headers=headers).status_code == 204
    assert api.get("/api/auth/me", headers=headers).status_code == 401
    assert api.post("/api/auth/logout", headers=headers).status_code == 401


def test_missing_auth_is_challenged(clean_db: dict[str, str], api: TestClient) -> None:
    _ = clean_db
    for method, path in (("get", "/api/auth/me"), ("post", "/api/auth/logout")):
        resp = api.request(method, path)
        assert resp.status_code == 401, resp.text
        assert resp.json()["error"]["code"] == "AUTH_REQUIRED"
        assert resp.headers.get("www-authenticate") == "Bearer"


def test_role_read_from_database_each_request(
    clean_db: dict[str, str], api: TestClient, migrator_conn: psycopg.Connection
) -> None:
    _ = clean_db
    email = _email()
    _register(api, email)
    raw = _login(api, email)["access_token"]
    assert api.get("/api/auth/me", headers=_auth(raw)).json()["role"] == "user"
    migrator_conn.execute(
        "UPDATE eventbook.users SET role = 'admin' WHERE email = %s", (email,)
    )
    migrator_conn.commit()
    assert api.get("/api/auth/me", headers=_auth(raw)).json()["role"] == "admin"


def test_admin_dependency(
    clean_db: dict[str, str], api: TestClient, migrator_conn: psycopg.Connection
) -> None:
    _ = clean_db
    assert api.get("/_test/admin-ping").status_code == 401
    email = _email()
    _register(api, email)
    user_headers = _auth(_login(api, email)["access_token"])
    denied = api.get("/_test/admin-ping", headers=user_headers)
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "ADMIN_REQUIRED"
    admin_email = _email()
    migrator_conn.execute(
        "INSERT INTO eventbook.users (id, email, password_hash, role) "
        "VALUES (%s, %s, %s, 'admin')",
        (str(uuid.uuid4()), admin_email, hash_password("Admin-Pass-789")),
    )
    migrator_conn.commit()
    admin_headers = _auth(_login(api, admin_email, "Admin-Pass-789")["access_token"])
    allowed = api.get("/_test/admin-ping", headers=admin_headers)
    assert allowed.status_code == 200, allowed.text
    assert allowed.json() == {"ok": True, "role": "admin"}


def test_login_rate_limit_blocks_after_failures(
    clean_db: dict[str, str], migrator_conn: psycopg.Connection
) -> None:
    _ = clean_db
    client = _rate_limited_client(attempts=3)
    email = _email()
    _register(client, email)
    for _ in range(3):
        resp = client.post(
            "/api/auth/login", json={"email": email, "password": "wrong-pass-1"}
        )
        assert resp.status_code == 401, resp.text
    # the bucket is full: even the correct password is refused now
    blocked = client.post(
        "/api/auth/login", json={"email": email, "password": "password-123"}
    )
    assert blocked.status_code == 429, blocked.text
    assert blocked.json() == {
        "error": {
            "code": "TOO_MANY_ATTEMPTS",
            "message": "Too many failed login attempts. Try again later.",
        }
    }
    retry_after = blocked.headers.get("retry-after", "")
    assert retry_after.isdigit() and 1 <= int(retry_after) <= 60
    assert blocked.headers.get("cache-control") == "no-store"
    # the bucket is one client address plus one email: other accounts are free
    other = client.post(
        "/api/auth/login", json={"email": _email(), "password": "password-123"}
    )
    assert other.status_code == 401, other.text
    assert other.json()["error"]["code"] == "INVALID_CREDENTIALS"
    # a throttled attempt creates no session
    (sessions,) = migrator_conn.execute(
        "SELECT count(*) FROM eventbook.sessions s "
        "JOIN eventbook.users u ON u.id = s.user_id WHERE u.email = %s",
        (email,),
    ).fetchone()
    assert sessions == 0


def test_login_rate_limit_counts_unknown_emails(
    clean_db: dict[str, str],
) -> None:
    _ = clean_db
    client = _rate_limited_client(attempts=3)
    email = _email()  # never registered: unknown accounts are bucketed too
    for _ in range(3):
        resp = client.post(
            "/api/auth/login", json={"email": email, "password": "password-123"}
        )
        assert resp.status_code == 401, resp.text
    blocked = client.post(
        "/api/auth/login", json={"email": email, "password": "password-123"}
    )
    assert blocked.status_code == 429, blocked.text
    assert blocked.json()["error"]["code"] == "TOO_MANY_ATTEMPTS"


def test_login_rate_limit_clears_after_successful_login(
    clean_db: dict[str, str],
) -> None:
    _ = clean_db
    client = _rate_limited_client(attempts=3)
    email = _email()
    _register(client, email)
    for _ in range(2):
        resp = client.post(
            "/api/auth/login", json={"email": email, "password": "wrong-pass-1"}
        )
        assert resp.status_code == 401, resp.text
    assert _login(client, email)["access_token"]
    # the success cleared the bucket: two more failures are still ordinary 401s
    # (they would be a 429 on the second one if the count had survived)
    for _ in range(2):
        resp = client.post(
            "/api/auth/login", json={"email": email, "password": "wrong-pass-1"}
        )
        assert resp.status_code == 401, resp.text


def test_login_rate_limit_window_expiry_allows_again(
    clean_db: dict[str, str],
) -> None:
    _ = clean_db
    client = _rate_limited_client(attempts=2, window_seconds=1)
    email = _email()
    _register(client, email)
    for _ in range(2):
        resp = client.post(
            "/api/auth/login", json={"email": email, "password": "wrong-pass-1"}
        )
        assert resp.status_code == 401, resp.text
    blocked = client.post(
        "/api/auth/login", json={"email": email, "password": "wrong-pass-1"}
    )
    assert blocked.status_code == 429, blocked.text
    time.sleep(1.1)  # let the whole window pass
    allowed = client.post(
        "/api/auth/login", json={"email": email, "password": "wrong-pass-1"}
    )
    assert allowed.status_code == 401, allowed.text

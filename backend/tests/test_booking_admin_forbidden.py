"""Admin booking restriction tests (management-only scope decision).

Administrators manage events and attendees; booking, personal history,
and cancellation serve normal users only. Admin requests to those three
endpoints fail with a clear 403 before any booking logic runs, while
anonymous callers still receive 401 first and normal-user rules keep
working end to end.
"""

import os
import uuid

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.passwords import hash_password


@pytest.fixture(scope="module")
def api() -> TestClient:
    settings = Settings(
        DATABASE_URL=os.environ["TEST_DATABASE_URL"],
        EXPECTED_ALEMBIC_REVISION=None,
    )
    return TestClient(create_app(settings))


@pytest.fixture()
def db(clean_db: dict[str, str]):  # type: ignore[no-untyped-def]
    with psycopg.connect(clean_db["migration_url"].replace("+psycopg://", "://")) as conn:
        yield conn
        conn.rollback()


def _email(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}@example.com"


def _register_login(api: TestClient, email: str) -> str:
    # No public promotion path exists by design; admin rows are inserted
    # directly (see _make_admin), exactly like the seed script does.
    assert api.post(
        "/api/auth/register", json={"email": email, "password": "password-123"}
    ).status_code == 201
    login = api.post("/api/auth/login", json={"email": email, "password": "password-123"})
    assert login.status_code == 200, login.text
    return login.json()["access_token"]


def _make_admin(api: TestClient, db: psycopg.Connection) -> str:
    email = _email("admrest")
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO eventbook.users (id, email, password_hash, role) "
            "VALUES (%s, %s, %s, 'admin')",
            (str(uuid.uuid4()), email, hash_password("password-123")),
        )
        db.commit()
    login = api.post("/api/auth/login", json={"email": email, "password": "password-123"})
    assert login.status_code == 200, login.text
    return login.json()["access_token"]


def _make_event(db: psycopg.Connection, days_ahead: float = 30, total_seats: int = 10) -> str:
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO eventbook.events (id, title, description, starts_at, venue, total_seats) "
            "VALUES (%s, 'Restricted', 'Scope fixture.', now() + make_interval(days => %s), 'Hall', %s) "
            "RETURNING id",
            (str(uuid.uuid4()), days_ahead, total_seats),
        )
        event_id = str(cur.fetchone()[0])
        db.commit()
    return event_id


def test_admin_booking_endpoints_forbidden(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin_headers = {"Authorization": f"Bearer {_make_admin(api, db)}"}
    event_id = _make_event(db)

    booking = api.post(f"/api/events/{event_id}/bookings", headers=admin_headers)
    assert booking.status_code == 403
    assert booking.json()["error"]["code"] == "ADMIN_BOOKING_FORBIDDEN"

    history = api.get("/api/bookings/me", headers=admin_headers)
    assert history.status_code == 403
    assert history.json()["error"]["code"] == "ADMIN_BOOKING_FORBIDDEN"

    missing = api.delete(f"/api/bookings/{uuid.uuid4()}", headers=admin_headers)
    assert missing.status_code == 403
    assert missing.json()["error"]["code"] == "ADMIN_BOOKING_FORBIDDEN"

    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO eventbook.users (id, email, password_hash) VALUES (%s, %s, %s) RETURNING id",
            (str(uuid.uuid4()), _email("usrest"), hash_password("password-123")),
        )
        victim = str(cur.fetchone()[0])
        cur.execute(
            "INSERT INTO eventbook.events (id, title, description, starts_at, venue, total_seats) "
            "VALUES (%s, 'Victim', 'Scope fixture.', now() + make_interval(days => 30), 'Hall', 10) "
            "RETURNING id",
            (str(uuid.uuid4()),),
        )
        event_id = str(cur.fetchone()[0])
        cur.execute(
            "INSERT INTO eventbook.bookings (id, user_id, event_id) VALUES (%s, %s, %s) RETURNING id",
            (str(uuid.uuid4()), victim, event_id),
        )
        booking_id = str(cur.fetchone()[0])
        db.commit()
    real = api.delete(f"/api/bookings/{booking_id}", headers=admin_headers)
    assert real.status_code == 403
    assert real.json()["error"]["code"] == "ADMIN_BOOKING_FORBIDDEN"
    with db.cursor() as cur:
        (active,) = cur.execute(
            "SELECT count(*) FROM eventbook.bookings WHERE id = %s",
            (booking_id,),
        ).fetchone()
        assert active == 1

    absent_event = api.post(
        f"/api/events/{uuid.uuid4()}/bookings", headers=admin_headers
    )
    assert absent_event.status_code == 403
    assert absent_event.json()["error"]["code"] == "ADMIN_BOOKING_FORBIDDEN"

    with db.cursor() as cur:
        (rows,) = cur.execute(
            "SELECT count(*) FROM eventbook.bookings WHERE cancelled_at IS NULL "
            "AND id <> %s",
            (booking_id,),
        ).fetchone()
        assert rows == 0


def test_expired_admin_token_gets_401_first(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin_headers = {"Authorization": f"Bearer {_make_admin(api, db)}"}
    with db.cursor() as cur:
        cur.execute(
            "UPDATE eventbook.sessions SET created_at = now() - interval '2 hours', "
            "expires_at = now() - interval '1 hour'"
        )
        db.commit()
    gone = api.get("/api/bookings/me", headers=admin_headers)
    assert gone.status_code == 401
    assert gone.json()["error"]["code"] == "INVALID_SESSION"


def test_anonymous_booking_endpoints_still_401(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    event_id = _make_event(db)
    for method, path in (
        ("POST", f"/api/events/{event_id}/bookings"),
        ("GET", "/api/bookings/me"),
        ("DELETE", f"/api/bookings/{uuid.uuid4()}"),
    ):
        resp = api.request(method, path)
        assert resp.status_code == 401, (method, path)
        assert resp.json()["error"]["code"] == "AUTH_REQUIRED"


def test_normal_user_booking_still_works(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    event_id = _make_event(db, total_seats=2)
    headers = {"Authorization": f"Bearer {_register_login(api, _email('usrest'))}"}
    created = api.post(f"/api/events/{event_id}/bookings", headers=headers)
    assert created.status_code == 201, created.text
    assert created.json()["event"]["seats_left"] == 1
    history = api.get("/api/bookings/me", headers=headers)
    assert history.status_code == 200 and history.json()["total"] == 1
    assert api.delete(f"/api/bookings/{created.json()['id']}", headers=headers).status_code == 204
    with db.cursor() as cur:
        (remaining,) = cur.execute(
            "SELECT count(*) FROM eventbook.bookings WHERE event_id = %s",
            (event_id,),
        ).fetchone()
        assert remaining == 0

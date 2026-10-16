"""Booking rule tests against isolated PostgreSQL (TASK-005, B1–B4).

Exercises the HTTP interface as two authenticated users: duplicate and
capacity rejection, past-event guards, owner-only cancellation that frees
the seat, rebooking after cancellation, and own-history isolation. Final
database state is asserted after every rejection.
"""

import os
import uuid

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


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


def _email() -> str:
    return f"book-{uuid.uuid4().hex[:12]}@example.com"


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _register_login(api: TestClient, email: str) -> str:
    assert api.post(
        "/api/auth/register", json={"email": email, "password": "password-123"}
    ).status_code == 201
    login = api.post("/api/auth/login", json={"email": email, "password": "password-123"})
    assert login.status_code == 200, login.text
    return login.json()["access_token"]


def _make_event(
    cur: psycopg.Cursor, title: str, days_ahead: float, total_seats: int = 10
) -> str:
    cur.execute(
        "INSERT INTO eventbook.events (id, title, description, starts_at, venue, total_seats) "
        "VALUES (%s, %s, %s, now() + make_interval(days => %s), %s, %s) RETURNING id",
        (str(uuid.uuid4()), title, f"About {title}.", days_ahead, "Hall", total_seats),
    )
    return str(cur.fetchone()[0])


def _active_count(cur: psycopg.Cursor, event_id: str) -> int:
    (count,) = cur.execute(
        "SELECT count(*) FROM eventbook.bookings "
        "WHERE event_id = %s AND cancelled_at IS NULL",
        (event_id,),
    ).fetchone()
    return count


def test_book_returns_201_and_decrements_seats(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        event_id = _make_event(cur, "Bookable", 9, total_seats=4)
        db.commit()
    token = _register_login(api, _email())
    resp = api.post(f"/api/events/{event_id}/bookings", headers=_auth(token))
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["cancelled_at"] is None
    assert body["event"]["id"] == event_id
    assert body["event"]["seats_left"] == 3
    assert body["created_at"].endswith("Z")
    assert resp.headers.get("cache-control") == "no-store"
    with db.cursor() as cur:
        assert _active_count(cur, event_id) == 1


def test_duplicate_active_booking_rejected(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        event_id = _make_event(cur, "Once", 9)
        db.commit()
    token = _register_login(api, _email())
    headers = _auth(token)
    assert api.post(f"/api/events/{event_id}/bookings", headers=headers).status_code == 201
    dup = api.post(f"/api/events/{event_id}/bookings", headers=headers)
    assert dup.status_code == 409
    assert dup.json()["error"]["code"] == "ALREADY_BOOKED"
    with db.cursor() as cur:
        assert _active_count(cur, event_id) == 1


def test_cancel_frees_seat_and_allows_rebook(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        event_id = _make_event(cur, "Rebookable", 9, total_seats=1)
        db.commit()
    token = _register_login(api, _email())
    headers = _auth(token)
    booking_id = api.post(f"/api/events/{event_id}/bookings", headers=headers).json()["id"]
    assert api.delete(f"/api/bookings/{booking_id}", headers=headers).status_code == 204
    assert api.get(f"/api/events/{event_id}").json()["seats_left"] == 1
    again = api.post(f"/api/events/{event_id}/bookings", headers=headers)
    assert again.status_code == 201
    with db.cursor() as cur:
        (total, active) = cur.execute(
            "SELECT count(*), count(*) FILTER (WHERE cancelled_at IS NULL) "
            "FROM eventbook.bookings WHERE event_id = %s",
            (event_id,),
        ).fetchone()
        assert (total, active) == (2, 1)


def test_full_event_rejects_booking(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        event_id = _make_event(cur, "Tiny", 9, total_seats=1)
        db.commit()
    first = _register_login(api, _email())
    second = _register_login(api, _email())
    assert api.post(f"/api/events/{event_id}/bookings", headers=_auth(first)).status_code == 201
    full = api.post(f"/api/events/{event_id}/bookings", headers=_auth(second))
    assert full.status_code == 409
    assert full.json()["error"]["code"] == "EVENT_FULL"
    with db.cursor() as cur:
        assert _active_count(cur, event_id) == 1


def test_past_event_booking_rejected(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        event_id = _make_event(cur, "Over", -2)
        db.commit()
    token = _register_login(api, _email())
    resp = api.post(f"/api/events/{event_id}/bookings", headers=_auth(token))
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "EVENT_STARTED"
    with db.cursor() as cur:
        assert _active_count(cur, event_id) == 0


def test_past_cancellation_rejected(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        event_id = _make_event(cur, "Elapsing", 9)
        db.commit()
    token = _register_login(api, _email())
    booking_id = api.post(f"/api/events/{event_id}/bookings", headers=_auth(token)).json()["id"]
    with db.cursor() as cur:
        cur.execute(
            "UPDATE eventbook.events SET starts_at = now() - interval '1 hour' WHERE id = %s",
            (event_id,),
        )
        db.commit()
    resp = api.delete(f"/api/bookings/{booking_id}", headers=_auth(token))
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "EVENT_STARTED"
    with db.cursor() as cur:
        (cancelled,) = cur.execute(
            "SELECT cancelled_at FROM eventbook.bookings WHERE id = %s", (booking_id,)
        ).fetchone()
        assert cancelled is None


def test_owner_only_cancellation(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        event_id = _make_event(cur, "Mine", 9)
        db.commit()
    owner = _register_login(api, _email())
    other = _register_login(api, _email())
    booking_id = api.post(f"/api/events/{event_id}/bookings", headers=_auth(owner)).json()["id"]
    intruder = api.delete(f"/api/bookings/{booking_id}", headers=_auth(other))
    assert intruder.status_code == 404
    assert intruder.json()["error"]["code"] == "NOT_FOUND"
    with db.cursor() as cur:
        assert _active_count(cur, event_id) == 1
    assert api.delete(f"/api/bookings/{booking_id}", headers=_auth(owner)).status_code == 204


def test_repeated_cancel_is_idempotent(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        event_id = _make_event(cur, "Twice", 9, total_seats=3)
        db.commit()
    token = _register_login(api, _email())
    headers = _auth(token)
    booking_id = api.post(f"/api/events/{event_id}/bookings", headers=headers).json()["id"]
    assert api.delete(f"/api/bookings/{booking_id}", headers=headers).status_code == 204
    assert api.delete(f"/api/bookings/{booking_id}", headers=headers).status_code == 204
    with db.cursor() as cur:
        (total, active) = cur.execute(
            "SELECT count(*), count(*) FILTER (WHERE cancelled_at IS NULL) "
            "FROM eventbook.bookings WHERE event_id = %s",
            (event_id,),
        ).fetchone()
        assert (total, active) == (1, 0)
        assert api.get(f"/api/events/{event_id}").json()["seats_left"] == 3


def test_own_history_pagination_and_isolation(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        ids = [_make_event(cur, f"H{i:02d}", day) for day, i in [(3, 1), (4, 2), (5, 3)]]
        other_event = _make_event(cur, "Theirs", 6)
        db.commit()
    mine = _register_login(api, _email())
    theirs = _register_login(api, _email())
    mine_headers, theirs_headers = _auth(mine), _auth(theirs)
    first_id = api.post(f"/api/events/{ids[0]}/bookings", headers=mine_headers).json()["id"]
    for event_id in ids[1:]:
        api.post(f"/api/events/{event_id}/bookings", headers=mine_headers)
    api.post(f"/api/events/{other_event}/bookings", headers=theirs_headers)
    api.delete(f"/api/bookings/{first_id}", headers=mine_headers)

    history = api.get("/api/bookings/me", headers=mine_headers).json()
    assert history["total"] == 3 and len(history["items"]) == 3
    assert history["items"][0]["created_at"] >= history["items"][-1]["created_at"]
    cancelled = [b for b in history["items"] if b["cancelled_at"] is not None]
    assert len(cancelled) == 1
    assert all("event" in item and "seats_left" in item["event"] for item in history["items"])
    assert history["items"][0]["created_at"].endswith("Z")
    assert api.get("/api/bookings/me", headers=mine_headers).headers.get("cache-control") == "no-store"

    strangers = api.get("/api/bookings/me", headers=theirs_headers).json()
    assert strangers["total"] == 1

    assert api.get("/api/bookings/me").status_code == 401
    bad_size = api.get("/api/bookings/me", params={"page_size": 51}, headers=mine_headers)
    assert bad_size.status_code == 422
    assert bad_size.json()["error"]["code"] == "VALIDATION_ERROR"


def test_booking_missing_event_and_invalid_uuid(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        _make_event(cur, "Only", 2)
        db.commit()
    token = _register_login(api, _email())
    headers = _auth(token)
    missing = api.post(f"/api/events/{uuid.uuid4()}/bookings", headers=headers)
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "NOT_FOUND"
    invalid = api.post("/api/events/not-a-uuid/bookings", headers=headers)
    assert invalid.status_code == 422
    bad_booking = api.delete("/api/bookings/not-a-uuid", headers=headers)
    assert bad_booking.status_code == 422


def test_booking_error_responses_are_not_storeable(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        event_id = _make_event(cur, "Cacheable", 9)
        db.commit()
    token = _register_login(api, _email())
    headers = _auth(token)

    anon = api.post(f"/api/events/{event_id}/bookings")
    assert anon.status_code == 401
    assert anon.headers.get("cache-control") == "no-store"

    missing = api.post(f"/api/events/{uuid.uuid4()}/bookings", headers=headers)
    assert missing.status_code == 404
    assert missing.headers.get("cache-control") == "no-store"

    assert api.post(f"/api/events/{event_id}/bookings", headers=headers).status_code == 201
    dup = api.post(f"/api/events/{event_id}/bookings", headers=headers)
    assert dup.status_code == 409
    assert dup.headers.get("cache-control") == "no-store"

    with db.cursor() as cur:
        tiny = _make_event(cur, "Tiny cache", 9, total_seats=1)
        past = _make_event(cur, "Past cache", -9)
        db.commit()
    other = _register_login(api, _email())
    assert api.post(f"/api/events/{tiny}/bookings", headers=headers).status_code == 201
    full = api.post(f"/api/events/{tiny}/bookings", headers=_auth(other))
    assert full.status_code == 409
    assert full.json()["error"]["code"] == "EVENT_FULL"
    assert full.headers.get("cache-control") == "no-store"
    started = api.post(f"/api/events/{past}/bookings", headers=headers)
    assert started.status_code == 409
    assert started.headers.get("cache-control") == "no-store"

    booking_id = api.post(f"/api/events/{event_id}/bookings", headers=_auth(other)).json()["id"]
    denied = api.delete(f"/api/bookings/{booking_id}", headers=headers)
    assert denied.status_code == 404
    assert denied.headers.get("cache-control") == "no-store"
    gone = api.delete(f"/api/bookings/{booking_id}", headers=_auth(other))
    assert gone.status_code == 204
    assert gone.headers.get("cache-control") == "no-store"


def test_booking_requires_auth(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        event_id = _make_event(cur, "Gated", 2)
        db.commit()
    assert api.post(f"/api/events/{event_id}/bookings").status_code == 401
    assert api.delete(f"/api/bookings/{uuid.uuid4()}").status_code == 401

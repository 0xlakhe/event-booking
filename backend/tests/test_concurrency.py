"""Transaction-protocol concurrency tests (TASK-005 mandatory semantics).

Pins the agreed protocol under real row locks: eligibility is judged with
fresh database time after the event lock is obtained (never request-arrival
time), and bounded lock waits surface as retryable 503s with no partial
writes. Threads synchronize on the database lock itself with bounded waits
and generous timeouts; either interleaving asserts the same outcome.

The dedicated simultaneous-last-seat race proof stays bonus work for
TASK-009 and is not claimed here.
"""

import os
import threading
import time
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
    return f"conc-{uuid.uuid4().hex[:12]}@example.com"


def _register_login(api: TestClient, email: str) -> str:
    assert api.post(
        "/api/auth/register", json={"email": email, "password": "password-123"}
    ).status_code == 201
    login = api.post("/api/auth/login", json={"email": email, "password": "password-123"})
    assert login.status_code == 200, login.text
    return login.json()["access_token"]


def _make_event(cur: psycopg.Cursor, title: str, days_ahead: float, total_seats: int) -> str:
    cur.execute(
        "INSERT INTO eventbook.events (id, title, description, starts_at, venue, total_seats) "
        "VALUES (%s, %s, %s, now() + make_interval(days => %s), %s, %s) RETURNING id",
        (str(uuid.uuid4()), title, f"About {title}.", days_ahead, "Hall", total_seats),
    )
    return str(cur.fetchone()[0])


def _post_booking(
    api: TestClient, event_id: str, token: str, slot: dict
) -> None:
    try:
        peer = TestClient(api.app)
        slot["response"] = peer.post(
            f"/api/events/{event_id}/bookings",
            headers={"Authorization": f"Bearer {token}"},
        )
    except Exception as exc:  # pragma: no cover - surfaced below
        slot["error"] = exc


def _delete_booking(api: TestClient, booking_id: str, token: str, slot: dict) -> None:
    try:
        peer = TestClient(api.app)
        slot["response"] = peer.delete(
            f"/api/bookings/{booking_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
    except Exception as exc:  # pragma: no cover - surfaced below
        slot["error"] = exc


def test_booking_eligibility_uses_post_lock_time(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    """The start time crosses over while the booking waits for the lock.

    The event starts ~2s out and the booking blocks ~3s on the held row
    lock, so request-arrival time still shows a future event. Only a
    fresh clock reading after lock acquisition rejects the booking; a
    stale transaction-start timestamp would wrongly accept it.
    """
    _ = clean_db
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO eventbook.events (id, title, description, starts_at, venue, total_seats) "
            "VALUES (%s, 'Crossing', 'Starts mid-wait.', now() + make_interval(secs => 2), 'Hall', 10) "
            "RETURNING id",
            (str(uuid.uuid4()),),
        )
        event_id = str(cur.fetchone()[0])
        db.commit()
    token = _register_login(api, _email())

    locker = psycopg.connect(clean_db["migration_url"].replace("+psycopg://", "://"))
    try:
        with locker.cursor() as lock_cur:
            lock_cur.execute(
                "SELECT id FROM eventbook.events WHERE id = %s FOR UPDATE", (event_id,)
            )
            slot: dict = {}
            worker = threading.Thread(
                target=_post_booking, args=(api, event_id, token, slot)
            )
            worker.start()
            time.sleep(3)  # the start time passes while the booking waits
            locker.commit()  # release the lock without touching the event
            worker.join(timeout=20)
            assert not worker.is_alive()
            assert "error" not in slot
            assert slot["response"].status_code == 409
            assert slot["response"].json()["error"]["code"] == "EVENT_STARTED"
    finally:
        locker.close()
    with db.cursor() as cur:
        (active,) = cur.execute(
            "SELECT count(*) FROM eventbook.bookings "
            "WHERE event_id = %s AND cancelled_at IS NULL",
            (event_id,),
        ).fetchone()
        assert active == 0


def test_cancellation_eligibility_uses_post_lock_time(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO eventbook.events (id, title, description, starts_at, venue, total_seats) "
            "VALUES (%s, 'Cancel crossing', 'Starts mid-wait.', "
            "now() + make_interval(secs => 2), 'Hall', 2) RETURNING id",
            (str(uuid.uuid4()),),
        )
        event_id = str(cur.fetchone()[0])
        db.commit()
    token = _register_login(api, _email())
    booking_id = api.post(
        f"/api/events/{event_id}/bookings", headers={"Authorization": f"Bearer {token}"}
    ).json()["id"]

    locker = psycopg.connect(clean_db["migration_url"].replace("+psycopg://", "://"))
    slot: dict = {}
    try:
        with locker.cursor() as lock_cur:
            lock_cur.execute(
                "SELECT id FROM eventbook.events WHERE id = %s FOR UPDATE", (event_id,)
            )
            worker = threading.Thread(
                target=_delete_booking, args=(api, booking_id, token, slot)
            )
            worker.start()
            deadline = time.monotonic() + 5
            waiting_for_lock = False
            while time.monotonic() < deadline:
                with db.cursor() as cur:
                    (waiting_for_lock,) = cur.execute(
                        "SELECT EXISTS (SELECT 1 FROM pg_locks "
                        "WHERE NOT granted AND pid <> pg_backend_pid())"
                    ).fetchone()
                if waiting_for_lock:
                    break
                if "response" in slot or "error" in slot:
                    break
                time.sleep(0.05)
            assert waiting_for_lock, slot
            time.sleep(3)  # the start time passes while cancellation waits
            locker.commit()  # release the lock without touching the event
            worker.join(timeout=20)
            assert not worker.is_alive()
            assert "error" not in slot
            assert slot["response"].status_code == 409
            assert slot["response"].json()["error"]["code"] == "EVENT_STARTED"
    finally:
        locker.close()

    with db.cursor() as cur:
        (remaining,) = cur.execute(
            "SELECT count(*) FROM eventbook.bookings WHERE id = %s", (booking_id,)
        ).fetchone()
        assert remaining == 1


def test_lock_timeout_is_retryable_without_mutation(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        event_id = _make_event(cur, "Contended", 30, total_seats=10)
        db.commit()
    token = _register_login(api, _email())

    locker = psycopg.connect(clean_db["migration_url"].replace("+psycopg://", "://"))
    slot: dict = {}
    try:
        with locker.cursor() as lock_cur:
            lock_cur.execute(
                "SELECT id FROM eventbook.events WHERE id = %s FOR UPDATE", (event_id,)
            )
            worker = threading.Thread(
                target=_post_booking, args=(api, event_id, token, slot)
            )
            started = time.monotonic()
            worker.start()
            time.sleep(6.5)  # exceed the 5s lock timeout while holding the row
            locker.rollback()
            worker.join(timeout=20)
            elapsed = time.monotonic() - started
            assert not worker.is_alive()
            assert "error" not in slot
            assert elapsed >= 4.5
            assert slot["response"].status_code == 503
            assert slot["response"].json()["error"]["code"] == "TEMPORARILY_UNAVAILABLE"
    finally:
        locker.close()
    with db.cursor() as cur:
        (active,) = cur.execute(
            "SELECT count(*) FROM eventbook.bookings "
            "WHERE event_id = %s AND cancelled_at IS NULL",
            (event_id,),
        ).fetchone()
        assert active == 0

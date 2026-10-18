"""Transaction-protocol concurrency tests (TASK-005 mandatory semantics).

Pins the agreed protocol under real row locks: eligibility is judged with
fresh database time after the event lock is obtained (never request-arrival
time), and bounded lock waits surface as retryable 503s with no partial
writes. Threads synchronize on the database lock itself with bounded waits
and generous timeouts; either interleaving asserts the same outcome.

The dedicated simultaneous-last-seat race proof (bonus work) lives at the
end of this module: two barrier-fired bookings contend for one remaining
seat, and a companion proof races a capacity edit against a booking. Both
serialize on the same event row lock and assert the same invariants in any
interleaving.
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


def _post_booking_at_barrier(
    api: TestClient, event_id: str, token: str, barrier: threading.Barrier, slot: dict
) -> None:
    try:
        peer = TestClient(api.app)
        barrier.wait(timeout=10)
        slot["response"] = peer.post(
            f"/api/events/{event_id}/bookings",
            headers={"Authorization": f"Bearer {token}"},
        )
    except Exception as exc:  # pragma: no cover - surfaced below
        slot["error"] = exc


def _patch_event(
    api: TestClient, event_id: str, token: str, payload: dict, slot: dict
) -> None:
    try:
        peer = TestClient(api.app)
        slot["response"] = peer.patch(
            f"/api/admin/events/{event_id}",
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
        )
    except Exception as exc:  # pragma: no cover - surfaced below
        slot["error"] = exc


def _create_admin(api: TestClient, db: psycopg.Connection, email: str) -> str:
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO eventbook.users (id, email, password_hash, role) "
            "VALUES (%s, %s, %s, 'admin')",
            (str(uuid.uuid4()), email, hash_password("Admin-Pass-789")),
        )
        db.commit()
    login = api.post(
        "/api/auth/login", json={"email": email, "password": "Admin-Pass-789"}
    )
    assert login.status_code == 200, login.text
    return login.json()["access_token"]


def _wait_for_lock_waiters(
    db: psycopg.Connection, minimum: int, timeout: float = 2.0
) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with db.cursor() as cur:
            (waiters,) = cur.execute(
                "SELECT count(*) FROM pg_locks "
                "WHERE NOT granted AND pid <> pg_backend_pid()"
            ).fetchone()
        if waiters >= minimum:
            return True
        time.sleep(0.05)
    return False


def _purge_fixture(db: psycopg.Connection, event_id: str, emails: list[str]) -> None:
    """Delete this proof's committed fixtures (the suite also truncates)."""
    with db.cursor() as cur:
        cur.execute("DELETE FROM eventbook.bookings WHERE event_id = %s", (event_id,))
        cur.execute(
            "DELETE FROM eventbook.sessions WHERE user_id IN "
            "(SELECT id FROM eventbook.users WHERE email = ANY(%s))",
            (emails,),
        )
        cur.execute("DELETE FROM eventbook.users WHERE email = ANY(%s)", (emails,))
        cur.execute("DELETE FROM eventbook.events WHERE id = %s", (event_id,))
        db.commit()


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


def test_simultaneous_last_seat_race_admits_exactly_one(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    """Two barrier-fired bookings race for the one remaining seat.

    Each request runs through its own client and pooled connection; the
    winner is decided by the event row lock, so any interleaving admits
    exactly one 201 and one EVENT_FULL 409, never two bookings.
    """
    _ = clean_db
    with db.cursor() as cur:
        event_id = _make_event(cur, "Last seat", 30, total_seats=1)
        db.commit()
    email_a, email_b = _email(), _email()
    token_a = _register_login(api, email_a)
    token_b = _register_login(api, email_b)
    barrier = threading.Barrier(2)
    slots: list[dict] = [{}, {}]
    threads = [
        threading.Thread(
            target=_post_booking_at_barrier, args=(api, event_id, token, barrier, slot)
        )
        for token, slot in ((token_a, slots[0]), (token_b, slots[1]))
    ]
    try:
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)
        assert all(not thread.is_alive() for thread in threads)
        for slot in slots:
            assert "error" not in slot, slot
        statuses = sorted(slot["response"].status_code for slot in slots)
        assert statuses == [201, 409], [slot["response"].text for slot in slots]
        loser = next(slot for slot in slots if slot["response"].status_code == 409)
        assert loser["response"].json()["error"]["code"] == "EVENT_FULL"
        winner = next(slot for slot in slots if slot["response"].status_code == 201)
        body = winner["response"].json()
        assert body["event"]["id"] == event_id
        assert body["event"]["seats_left"] == 0
        with db.cursor() as cur:
            (active,) = cur.execute(
                "SELECT count(*) FROM eventbook.bookings "
                "WHERE event_id = %s AND cancelled_at IS NULL",
                (event_id,),
            ).fetchone()
        assert active == 1
    finally:
        _purge_fixture(db, event_id, [email_a, email_b])


def test_capacity_edit_races_booking_without_overbooking(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    """An admin capacity edit and a booking contend for the same event row.

    Both writers take the event row lock, so the outcomes serialize in
    either order: the booking takes the second seat and the edit shrinks
    capacity to the booked count. The final state satisfies
    active <= capacity with no lost update.
    """
    _ = clean_db
    with db.cursor() as cur:
        event_id = _make_event(cur, "Contended edit", 30, total_seats=2)
        db.commit()
    email = _email()
    token = _register_login(api, email)
    admin_email = _email()
    admin_token = _create_admin(api, db, admin_email)

    booking_slot: dict = {}
    edit_slot: dict = {}
    booking_worker = threading.Thread(
        target=_post_booking, args=(api, event_id, token, booking_slot)
    )
    edit_worker = threading.Thread(
        target=_patch_event,
        args=(api, event_id, admin_token, {"total_seats": 1}, edit_slot),
    )

    locker = psycopg.connect(clean_db["migration_url"].replace("+psycopg://", "://"))
    try:
        with locker.cursor() as lock_cur:
            lock_cur.execute(
                "SELECT id FROM eventbook.events WHERE id = %s FOR UPDATE", (event_id,)
            )
            booking_worker.start()
            assert _wait_for_lock_waiters(db, minimum=1), booking_slot
            edit_worker.start()
            assert _wait_for_lock_waiters(db, minimum=2), edit_slot
            locker.commit()  # release; the queued writers serialize on the row
        booking_worker.join(timeout=20)
        edit_worker.join(timeout=20)
        assert not booking_worker.is_alive() and not edit_worker.is_alive()
        assert "error" not in booking_slot and "error" not in edit_slot
        assert booking_slot["response"].status_code == 201, booking_slot["response"].text
        assert edit_slot["response"].status_code == 200, edit_slot["response"].text
        assert edit_slot["response"].json()["total_seats"] == 1
        with db.cursor() as cur:
            (active,) = cur.execute(
                "SELECT count(*) FROM eventbook.bookings "
                "WHERE event_id = %s AND cancelled_at IS NULL",
                (event_id,),
            ).fetchone()
            (capacity,) = cur.execute(
                "SELECT total_seats FROM eventbook.events WHERE id = %s", (event_id,)
            ).fetchone()
        assert active == 1
        assert capacity == 1
        assert active <= capacity
    finally:
        locker.close()
        _purge_fixture(db, event_id, [email, admin_email])

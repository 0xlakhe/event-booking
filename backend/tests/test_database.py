"""Database contract tests against isolated PostgreSQL (TASK-002).

Covers the partial-unique booking rule at the constraint level, rebooking
after cancellation, FK/CHECK enforcement, runtime least-privilege grants,
cross-database isolation, and refusal of wrong test targets. Uses raw SQL
so the constraints and grants themselves are exercised, not the ORM.
"""

import os
import uuid

import psycopg
import pytest
from psycopg import errors as pg_errors
from sqlalchemy import inspect

from app.db import engine_from_url
from app.passwords import hash_password
from app.seed import _ensure_seed_booking
from tests.conftest import (
    db_name_of,
    require_test_urls,
    validate_live_test_target,
)


def _pg(url: str, **kwargs) -> psycopg.Connection:
    return psycopg.connect(url.replace("+psycopg://", "://"), **kwargs)


def _unique_email() -> str:
    return f"t-{uuid.uuid4().hex[:12]}@example.com"


def _make_user(cur: psycopg.Cursor, email: str | None = None) -> str:
    email = email or _unique_email()
    cur.execute(
        "INSERT INTO eventbook.users (id, email, password_hash) VALUES (%s, %s, %s) RETURNING id",
        (str(uuid.uuid4()), email, hash_password("password-123")),
    )
    return str(cur.fetchone()[0])


def _make_event(cur: psycopg.Cursor, total_seats: int = 10, days_ahead: int = 30) -> str:
    cur.execute(
        "INSERT INTO eventbook.events (id, title, description, starts_at, venue, total_seats) "
        "VALUES (%s, %s, %s, now() + make_interval(days => %s), %s, %s) RETURNING id",
        (str(uuid.uuid4()), "Contract event", "Constraint fixture.", days_ahead, "Hall", total_seats),
    )
    return str(cur.fetchone()[0])


def _book(cur: psycopg.Cursor, user_id: str, event_id: str) -> str:
    cur.execute(
        "INSERT INTO eventbook.bookings (id, user_id, event_id) VALUES (%s, %s, %s) RETURNING id",
        (str(uuid.uuid4()), user_id, event_id),
    )
    return str(cur.fetchone()[0])


def test_partial_unique_blocks_duplicate_active_booking(clean_db: dict[str, str]) -> None:
    with _pg(clean_db["migration_url"]) as conn:
        with conn.cursor() as cur:
            user_id, event_id = _make_user(cur), _make_event(cur)
            _book(cur, user_id, event_id)
            conn.commit()
            with pytest.raises(pg_errors.UniqueViolation):
                _book(cur, user_id, event_id)
            conn.rollback()
            (active,) = cur.execute(
                "SELECT count(*) FROM eventbook.bookings "
                "WHERE user_id = %s AND event_id = %s AND cancelled_at IS NULL",
                (user_id, event_id),
            ).fetchone()
            assert active == 1


def test_rebooking_after_cancellation_allowed(clean_db: dict[str, str]) -> None:
    with _pg(clean_db["migration_url"]) as conn:
        with conn.cursor() as cur:
            user_id, event_id = _make_user(cur), _make_event(cur)
            _book(cur, user_id, event_id)
            cur.execute(
                "UPDATE eventbook.bookings SET cancelled_at = now() "
                "WHERE user_id = %s AND event_id = %s",
                (user_id, event_id),
            )
            _book(cur, user_id, event_id)
            conn.commit()
            (active,) = cur.execute(
                "SELECT count(*) FROM eventbook.bookings "
                "WHERE user_id = %s AND event_id = %s AND cancelled_at IS NULL",
                (user_id, event_id),
            ).fetchone()
            assert active == 1


def test_fk_and_check_constraints(clean_db: dict[str, str]) -> None:
    with _pg(clean_db["migration_url"]) as conn:
        with conn.cursor() as cur:
            user_id = _make_user(cur)
            with pytest.raises(pg_errors.ForeignKeyViolation):
                _book(cur, user_id, str(uuid.uuid4()))
            conn.rollback()
            with pytest.raises(pg_errors.CheckViolation):
                _make_event(cur, total_seats=0)
            conn.rollback()
            with pytest.raises(pg_errors.CheckViolation):
                cur.execute(
                    "INSERT INTO eventbook.users (id, email, password_hash, role) "
                    "VALUES (%s, %s, %s, %s)",
                    (str(uuid.uuid4()), _unique_email(), hash_password("x" * 12), "superadmin"),
                )
            conn.rollback()
            with pytest.raises(pg_errors.CheckViolation):
                cur.execute(
                    "INSERT INTO eventbook.users (id, email, password_hash) VALUES (%s, %s, %s)",
                    (str(uuid.uuid4()), "NOT-LOWERCASE@example.com", hash_password("x" * 12)),
                )
            conn.rollback()


def test_runtime_cannot_self_promote_but_can_register(clean_db: dict[str, str]) -> None:
    # Setup through the privileged migrator connection.
    with _pg(clean_db["migration_url"]) as conn:
        with conn.cursor() as cur:
            victim = _make_user(cur)
            conn.commit()
    # Attack attempts through the restricted runtime connection.
    with _pg(clean_db["runtime_url"]) as conn:
        with conn.cursor() as cur:
            with pytest.raises(pg_errors.InsufficientPrivilege):
                cur.execute("UPDATE eventbook.users SET role = 'admin' WHERE id = %s", (victim,))
            conn.rollback()
            with pytest.raises(pg_errors.InsufficientPrivilege):
                cur.execute(
                    "INSERT INTO eventbook.users (id, email, password_hash, role) "
                    "VALUES (%s, %s, %s, 'admin')",
                    (str(uuid.uuid4()), _unique_email(), hash_password("x" * 12)),
                )
            conn.rollback()
            # Omission path: role falls back to the server default 'user'.
            email = _unique_email()
            cur.execute(
                "INSERT INTO eventbook.users (id, email, password_hash) "
                "VALUES (%s, %s, %s) RETURNING role",
                (str(uuid.uuid4()), email, hash_password("password-123")),
            )
            assert cur.fetchone()[0] == "user"
            conn.commit()
            (role,) = cur.execute(
                "SELECT role FROM eventbook.users WHERE email = %s", (email,)
            ).fetchone()
            assert role == "user"


def test_runtime_cannot_create_tables(clean_db: dict[str, str]) -> None:
    with _pg(clean_db["runtime_url"]) as conn:
        with conn.cursor() as cur:
            with pytest.raises(pg_errors.InsufficientPrivilege):
                cur.execute("CREATE TABLE eventbook.evil (id integer PRIMARY KEY)")
            conn.rollback()


def test_runtime_can_delete_bookings_but_cannot_soft_cancel(
    clean_db: dict[str, str],
) -> None:
    with _pg(clean_db["runtime_url"]) as conn:
        with conn.cursor() as cur:
            can_delete, can_update_cancelled = cur.execute(
                "SELECT has_table_privilege(current_user, 'eventbook.bookings', 'DELETE'), "
                "has_column_privilege(current_user, 'eventbook.bookings', 'cancelled_at', 'UPDATE')"
            ).fetchone()
    assert can_delete
    assert not can_update_cancelled


def test_public_has_no_eventbook_access(clean_db: dict[str, str]) -> None:
    with _pg(clean_db["migration_url"]) as conn:
        with conn.cursor() as cur:
            (usage,) = cur.execute(
                "SELECT has_schema_privilege('public', 'eventbook', 'USAGE')"
            ).fetchone()
            assert usage is False


def test_cross_database_isolation(clean_db: dict[str, str]) -> None:
    dev_db = os.environ.get("POSTGRES_DB", "eventbook_dev")
    runtime_user = os.environ.get("POSTGRES_TEST_RUNTIME_USER", "eventbook_test_runtime")
    runtime_password = os.environ["POSTGRES_TEST_RUNTIME_PASSWORD"]
    # Test-runtime credentials must not open the development database.
    dev_url = f"postgresql://{runtime_user}:{runtime_password}@db:5432/{dev_db}"
    assert db_name_of(dev_url) == dev_db
    with pytest.raises(psycopg.OperationalError):
        psycopg.connect(dev_url, connect_timeout=3).close()
    # And the test database rejects the wrong password just the same.
    bad_url = (
        f"postgresql://{runtime_user}:wrong-password@db:5432/"
        f"{db_name_of(clean_db['runtime_url'])}"
    )
    with pytest.raises(psycopg.OperationalError):
        psycopg.connect(bad_url, connect_timeout=3).close()


def test_wrong_test_target_refused_before_destructive_ops(
    clean_db: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    dev_url = "postgresql+psycopg://u:p@db:5432/eventbook_dev"
    monkeypatch.setenv("TEST_MIGRATION_DATABASE_URL", dev_url)
    with pytest.raises(RuntimeError, match="Refusing"):
        require_test_urls()
    monkeypatch.setenv("TEST_MIGRATION_DATABASE_URL", clean_db["migration_url"])
    monkeypatch.setenv("TEST_DATABASE_URL", dev_url)
    with pytest.raises(RuntimeError, match="Refusing"):
        require_test_urls()


def test_spoofed_test_db_name_still_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    """Overriding the test-database name must not bless development URLs."""
    monkeypatch.setenv("POSTGRES_TEST_DB", "eventbook_dev")
    monkeypatch.setenv(
        "TEST_MIGRATION_DATABASE_URL",
        "postgresql+psycopg://eventbook_migrator:pw@db:5432/eventbook_dev",
    )
    monkeypatch.setenv(
        "TEST_DATABASE_URL",
        "postgresql+psycopg://eventbook_runtime:pw@db:5432/eventbook_dev",
    )
    with pytest.raises(RuntimeError, match="Refusing"):
        require_test_urls()


def test_test_db_name_override_ignored_for_correct_urls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The fixed target holds even when the legacy override disagrees."""
    monkeypatch.setenv("POSTGRES_TEST_DB", "eventbook_dev")
    migration_url, runtime_url = require_test_urls()
    assert db_name_of(migration_url) == "eventbook_test"
    assert db_name_of(runtime_url) == "eventbook_test"


def test_live_target_validation_accepts_test_db(clean_db: dict[str, str]) -> None:
    validate_live_test_target(clean_db["migration_url"], clean_db["runtime_url"])


def test_live_target_validation_refuses_dev_database(clean_db: dict[str, str]) -> None:
    dev_db = os.environ.get("POSTGRES_DB", "eventbook_dev")
    dev_migrator = os.environ.get("POSTGRES_MIGRATION_USER", "eventbook_migrator")
    dev_password = os.environ["POSTGRES_MIGRATION_PASSWORD"]
    dev_migration_url = (
        f"postgresql+psycopg://{dev_migrator}:{dev_password}@db:5432/{dev_db}"
    )
    with pytest.raises(RuntimeError, match="Refusing test target"):
        validate_live_test_target(dev_migration_url, clean_db["runtime_url"])


def _seed_case(conn, total_seats: int, days_ahead: int) -> tuple[str, str]:
    """Create one user and one future/past event; return (user_id, event_id)."""
    from sqlalchemy import text as sa_text

    user_id, event_id = str(uuid.uuid4()), str(uuid.uuid4())
    conn.execute(
        sa_text(
            "INSERT INTO eventbook.users (id, email, password_hash) "
            "VALUES (:id, :email, :hash)"
        ),
        {"id": user_id, "email": _unique_email(), "hash": hash_password("password-123")},
    )
    conn.execute(
        sa_text(
            "INSERT INTO eventbook.events (id, title, description, starts_at, venue, total_seats) "
            "VALUES (:id, 'Seed case', 'Lock-protocol fixture.', "
            "now() + make_interval(days => :days), 'Hall', :seats)"
        ),
        {"id": event_id, "days": days_ahead, "seats": total_seats},
    )
    return user_id, event_id


def test_seed_booking_never_overbooks_full_event(clean_db: dict[str, str]) -> None:
    from sqlalchemy import text as sa_text

    engine = engine_from_url(clean_db["migration_url"], pool_size=1, connect_timeout=5)
    try:
        with engine.begin() as conn:
            user_id, event_id = _seed_case(conn, total_seats=2, days_ahead=30)
            for _ in range(2):
                other = str(uuid.uuid4())
                conn.execute(
                    sa_text(
                        "INSERT INTO eventbook.users (id, email, password_hash) "
                        "VALUES (:id, :email, :hash)"
                    ),
                    {
                        "id": other,
                        "email": _unique_email(),
                        "hash": hash_password("password-123"),
                    },
                )
                conn.execute(
                    sa_text(
                        "INSERT INTO eventbook.bookings (id, user_id, event_id) "
                        "VALUES (:id, :user_id, :event_id)"
                    ),
                    {"id": str(uuid.uuid4()), "user_id": other, "event_id": event_id},
                )
            # Cancelled history must survive the skipped run untouched.
            cancelled_id = str(uuid.uuid4())
            conn.execute(
                sa_text(
                    "INSERT INTO eventbook.bookings (id, user_id, event_id, cancelled_at) "
                    "VALUES (:id, :user_id, :event_id, now())"
                ),
                {"id": cancelled_id, "user_id": user_id, "event_id": event_id},
            )
            assert _ensure_seed_booking(conn, uuid.UUID(user_id), uuid.UUID(event_id)) == "skipped-full"
        with engine.connect() as conn:
            (active,) = conn.execute(
                sa_text(
                    "SELECT count(*) FROM eventbook.bookings "
                    "WHERE event_id = :event_id AND cancelled_at IS NULL"
                ),
                {"event_id": event_id},
            ).fetchone()
            assert active == 2
            row = conn.execute(
                sa_text(
                    "SELECT cancelled_at FROM eventbook.bookings WHERE id = :id"
                ),
                {"id": cancelled_id},
            ).fetchone()
            assert row[0] is not None
    finally:
        engine.dispose()


def test_seed_booking_skips_past_event_and_creates_once(
    clean_db: dict[str, str],
) -> None:
    engine = engine_from_url(clean_db["migration_url"], pool_size=1, connect_timeout=5)
    try:
        with engine.begin() as conn:
            user_id, past_id = _seed_case(conn, total_seats=10, days_ahead=-30)
            assert _ensure_seed_booking(conn, uuid.UUID(user_id), uuid.UUID(past_id)) == "skipped-past"
            user_id2, future_id = _seed_case(conn, total_seats=10, days_ahead=30)
            assert _ensure_seed_booking(conn, uuid.UUID(user_id2), uuid.UUID(future_id)) == "created"
            assert _ensure_seed_booking(conn, uuid.UUID(user_id2), uuid.UUID(future_id)) == "present"
    finally:
        engine.dispose()


def test_migration_matches_models(clean_db: dict[str, str]) -> None:
    """The frozen migration must create exactly what the models declare."""
    from sqlalchemy import CheckConstraint

    from app.models import Base

    engine = engine_from_url(clean_db["migration_url"], pool_size=1, connect_timeout=5)
    try:
        inspector = inspect(engine)
        for qualified in ("users", "sessions", "events", "bookings"):
            model_table = Base.metadata.tables[f"eventbook.{qualified}"]
            live_columns = {
                column["name"]
                for column in inspector.get_columns(qualified, schema="eventbook")
            }
            assert {column.name for column in model_table.columns} == live_columns
            model_checks = {
                constraint.name
                for constraint in model_table.constraints
                if isinstance(constraint, CheckConstraint)
            }
            live_checks = {
                constraint["name"]
                for constraint in inspector.get_check_constraints(
                    qualified, schema="eventbook"
                )
            }
            assert model_checks == live_checks
            live_indexes = {
                index["name"]
                for index in inspector.get_indexes(qualified, schema="eventbook")
            }
            for index in model_table.indexes:
                assert index.name in live_indexes
    finally:
        engine.dispose()

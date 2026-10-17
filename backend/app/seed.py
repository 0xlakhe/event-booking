"""Repeatable demo seed for the development database (explicit runs only).

Creates the admin/user accounts, 12 upcoming events plus one past event,
and one normal-user booking that leaves a capacity-2 event nearly full.
Reruns create only missing rows: existing passwords, roles, timestamps,
and non-seed data are never modified or deleted.
"""

import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from sqlalchemy import create_engine, text

from .passwords import hash_password

ADMIN_ID = uuid.UUID("11111111-1111-4111-8111-111111111111")
USER_ID = uuid.UUID("22222222-2222-4222-8222-222222222222")
EVENT_IDS = [uuid.UUID(f"30000000-0000-4000-8000-{i:012d}") for i in range(1, 14)]

# The nearly-full event: capacity 2 with one seeded normal-user booking.
NEARLY_FULL_INDEX = 2
PAST_INDEX = 12


@dataclass(frozen=True)
class SeedConfig:
    database_url: str
    admin_email: str
    admin_password: str
    user_email: str
    user_password: str

    @staticmethod
    def _required(name: str) -> str:
        value = os.environ.get(name, "")
        if not value:
            raise RuntimeError(f"{name} is required for seeding")
        return value

    @classmethod
    def from_env(cls) -> "SeedConfig":
        return cls(
            database_url=cls._required("MIGRATION_DATABASE_URL"),
            admin_email=os.environ.get("SEED_ADMIN_EMAIL", "admin@example.com"),
            admin_password=cls._required("SEED_ADMIN_PASSWORD"),
            user_email=os.environ.get("SEED_USER_EMAIL", "user@example.com"),
            user_password=cls._required("SEED_USER_PASSWORD"),
        )


def _event_rows(now: datetime) -> list[dict]:
    rows = []
    for i, event_id in enumerate(EVENT_IDS):
        if i == PAST_INDEX:
            starts_at = now - timedelta(days=7)
            capacity = 50
        else:
            starts_at = now + timedelta(days=i + 1)
            capacity = 2 if i == NEARLY_FULL_INDEX else 50
        rows.append(
            {
                "id": str(event_id),
                "title": f"Seed Event {i + 1:02d}",
                "description": f"Seeded demo event number {i + 1}.",
                "starts_at": starts_at,
                "venue": f"Kathmandu Hall {i + 1}",
                "total_seats": capacity,
            }
        )
    return rows


def _ensure_seed_booking(conn, user_id: uuid.UUID, event_id: uuid.UUID) -> str:
    """Ensure the seeded nearly-full booking following the event-lock protocol.

    The booking belongs to the seeded normal user: administrators are
    management-only and never book. Locks the event row first, then
    re-reads time, duplicate, and capacity with fresh state. Never
    overbooks a full event, never books a past event, and never touches
    cancelled history rows. Returns one of "present", "created",
    "skipped-full", "skipped-past", "skipped-missing".
    """
    event = conn.execute(
        text(
            "SELECT id, starts_at, total_seats FROM eventbook.events "
            "WHERE id = :event_id FOR UPDATE"
        ),
        {"event_id": str(event_id)},
    ).mappings().fetchone()
    if event is None:
        return "skipped-missing"
    now_db = conn.execute(text("SELECT clock_timestamp()")).scalar()
    if event["starts_at"] <= now_db:
        return "skipped-past"
    duplicate = conn.execute(
        text(
            "SELECT id FROM eventbook.bookings "
            "WHERE user_id = :user_id AND event_id = :event_id "
            "AND cancelled_at IS NULL"
        ),
        {"user_id": str(user_id), "event_id": str(event_id)},
    ).scalar()
    if duplicate is not None:
        return "present"
    (active,) = conn.execute(
        text(
            "SELECT count(*) FROM eventbook.bookings "
            "WHERE event_id = :event_id AND cancelled_at IS NULL"
        ),
        {"event_id": str(event_id)},
    ).fetchone()
    if active >= event["total_seats"]:
        return "skipped-full"
    conn.execute(
        text(
            "INSERT INTO eventbook.bookings (id, user_id, event_id) "
            "VALUES (:id, :user_id, :event_id)"
        ),
        {
            "id": str(uuid.uuid4()),
            "user_id": str(user_id),
            "event_id": str(event_id),
        },
    )
    return "created"


def run_seed(cfg: SeedConfig) -> dict[str, int]:
    """Insert missing seed rows in one transaction; return creation counts."""
    # Fixed refusal: the isolated test database is never a seed target,
    # regardless of environment overrides (which are ignored here).
    dbname = urlparse(cfg.database_url.replace("+psycopg", "")).path.lstrip("/")
    if dbname == "eventbook_test":
        raise RuntimeError(f"Refusing to seed the isolated test database ({dbname})")

    report = {"users_created": 0, "events_created": 0, "bookings_created": 0, "bookings_skipped": 0}
    engine = create_engine(cfg.database_url)
    now = datetime.now(timezone.utc)
    with engine.begin() as conn:
        users = [
            (ADMIN_ID, cfg.admin_email, cfg.admin_password, "admin"),
            (USER_ID, cfg.user_email, cfg.user_password, "user"),
        ]
        for user_id, email, password, role in users:
            existing = conn.execute(
                text("SELECT id FROM eventbook.users WHERE email = :email"),
                {"email": email},
            ).scalar()
            if existing is None:
                conn.execute(
                    text(
                        "INSERT INTO eventbook.users (id, email, password_hash, role) "
                        "VALUES (:id, :email, :hash, :role)"
                    ),
                    {
                        "id": str(user_id),
                        "email": email,
                        "hash": hash_password(password),
                        "role": role,
                    },
                )
                report["users_created"] += 1

        for row in _event_rows(now):
            existing = conn.execute(
                text("SELECT id FROM eventbook.events WHERE id = :id"), {"id": row["id"]}
            ).scalar()
            if existing is None:
                conn.execute(
                    text(
                        "INSERT INTO eventbook.events "
                        "(id, title, description, starts_at, venue, total_seats) "
                        "VALUES (:id, :title, :description, :starts_at, :venue, :total_seats)"
                    ),
                    row,
                )
                report["events_created"] += 1

        outcome = _ensure_seed_booking(conn, USER_ID, EVENT_IDS[NEARLY_FULL_INDEX])
        if outcome == "created":
            report["bookings_created"] += 1
        elif outcome != "present":
            report["bookings_skipped"] += 1
    engine.dispose()
    return report


def main() -> None:
    report = run_seed(SeedConfig.from_env())
    for key in sorted(report):
        print(f"{key}: {report[key]}")


if __name__ == "__main__":
    main()

"""Own bookings: book one seat, history, cancel (TASK-005).

Owns rules B1–B4 and their transactions. Every mutation locks the same
event row first (READ COMMITTED), then re-checks fresh database time and
booking state before writing; success returns only after commit.
Authentication already closed its own read before these functions run,
so each write transaction starts with no open prior transaction.
"""

import uuid
from datetime import datetime

from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine, RowMapping
from sqlalchemy.exc import IntegrityError, OperationalError

from .auth import UserActor, require_non_admin
from .config import Settings
from .db import get_engine
from .errors import ApiError
from .events import EventSummary, utc_z
from .pagination import DEFAULT_PAGE, DEFAULT_PAGE_SIZE, envelope, parse_pagination

LOCK_TIMEOUT = "5s"
STATEMENT_TIMEOUT = "10s"


class BookingPublic(BaseModel):
    id: uuid.UUID
    event: EventSummary
    created_at: str


def _timeouts(conn: Connection) -> None:
    """Bound a write transaction; must run before any other statement."""
    conn.execute(text(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'"))
    conn.execute(text(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'"))


@contextmanager
def write_event(
    engine: Engine, event_id: uuid.UUID
) -> Iterator[tuple[Connection, RowMapping, datetime]]:
    """Lock one event for writing; yields (connection, event row, db time).

    Sets bounded timeouts, locks the event row first, then reads fresh
    database time — the shared write protocol for bookings and admin
    edits. Raises 404 when the event is missing, 503 on lock/statement
    timeouts. Callers run further checks and exactly one mutation inside
    the yielded transaction, which commits on clean exit.
    """
    try:
        with engine.begin() as conn:
            _timeouts(conn)
            event = conn.execute(
                text(
                    "SELECT id, starts_at, total_seats FROM eventbook.events "
                    "WHERE id = :event_id FOR UPDATE"
                ),
                {"event_id": str(event_id)},
            ).mappings().fetchone()
            if event is None:
                raise ApiError(404, "NOT_FOUND", "Event not found.")
            now_db: datetime = conn.execute(text("SELECT clock_timestamp()")).scalar()
            yield conn, event, now_db
    except OperationalError as exc:
        # Lock/statement timeout or lost connection: rolled back above,
        # safe for the caller to retry after refetching state.
        raise ApiError(
            503, "TEMPORARILY_UNAVAILABLE", "Service temporarily unavailable."
        ) from exc


def _to_booking(row) -> dict:  # type: ignore[no-untyped-def]
    return BookingPublic(
        id=row["id"],
        event=EventSummary(
            id=row["eid"],
            title=row["title"],
            starts_at=utc_z(row["starts_at"]),
            venue=row["venue"],
            total_seats=row["total_seats"],
            seats_left=row["seats_left"],
        ),
        created_at=utc_z(row["created_at"]),
    ).model_dump(mode="json")


def _pg_state(exc: IntegrityError) -> str | None:
    orig = getattr(exc, "orig", None)
    return getattr(orig, "pgcode", None) or getattr(orig, "sqlstate", None)


def _constraint_name(exc: IntegrityError) -> str | None:
    """psycopg constraint name behind a unique violation, if reported."""
    diag = getattr(getattr(exc, "orig", None), "diag", None)
    return getattr(diag, "constraint_name", None)


def book_seat(engine: Engine, actor: UserActor, event_id: uuid.UUID) -> dict:
    """Book one seat for the actor; raises ApiError on any rule failure."""
    try:
        with write_event(engine, event_id) as (conn, event, now_db):
            if event["starts_at"] <= now_db:
                raise ApiError(409, "EVENT_STARTED", "This event has already started.")
            duplicate = conn.execute(
                text(
                    "SELECT id FROM eventbook.bookings "
                    "WHERE user_id = :user_id AND event_id = :event_id "
                    "AND cancelled_at IS NULL"
                ),
                {"user_id": str(actor.id), "event_id": str(event_id)},
            ).scalar()
            if duplicate is not None:
                raise ApiError(409, "ALREADY_BOOKED", "You have already booked this event.")
            (active,) = conn.execute(
                text(
                    "SELECT count(*) FROM eventbook.bookings "
                    "WHERE event_id = :event_id AND cancelled_at IS NULL"
                ),
                {"event_id": str(event_id)},
            ).fetchone()
            if active >= event["total_seats"]:
                raise ApiError(409, "EVENT_FULL", "This event is full.")
            booking_id = str(uuid.uuid4())
            conn.execute(
                text(
                    "INSERT INTO eventbook.bookings (id, user_id, event_id) "
                    "VALUES (:id, :user_id, :event_id)"
                ),
                {"id": booking_id, "user_id": str(actor.id), "event_id": str(event_id)},
            )
    except IntegrityError as exc:
        # Backstop for a commit-time race the pre-checks could not see.
        # Confirm the partial-unique constraint so an unrelated unique
        # collision (e.g. a UUID primary-key clash) never misreports as
        # a duplicate booking. Unknown diagnostics keep the old mapping.
        if _pg_state(exc) != "23505" or _constraint_name(exc) not in (
            None,
            "uq_bookings_user_event_active",
        ):
            raise
        raise ApiError(409, "ALREADY_BOOKED", "You have already booked this event.") from exc
    with engine.connect() as conn:
        row = conn.execute(
            text(
                "SELECT b.id, b.created_at, "
                "e.id AS eid, e.title, e.description, e.starts_at, e.venue, "
                "e.total_seats, e.total_seats - COUNT(ba.id) AS seats_left "
                "FROM eventbook.bookings b "
                "JOIN eventbook.events e ON e.id = b.event_id "
                "LEFT JOIN eventbook.bookings ba "
                "ON ba.event_id = e.id AND ba.cancelled_at IS NULL "
                "WHERE b.id = :booking_id "
                "GROUP BY b.id, e.id"
            ),
            {"booking_id": booking_id},
        ).mappings().fetchone()
    assert row is not None
    return _to_booking(row)


def list_my_bookings(
    engine: Engine, actor: UserActor, page: int, page_size: int
) -> dict:
    """The actor's current bookings, newest first."""
    page, page_size = parse_pagination(page, page_size)
    offset = (page - 1) * page_size
    params: dict = {"user_id": str(actor.id), "limit": page_size, "offset": offset}
    with engine.begin() as conn:
        conn.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
        (total,) = conn.execute(
            text(
                "SELECT count(*) FROM eventbook.bookings "
                "WHERE user_id = :user_id AND cancelled_at IS NULL"
            ),
            params,
        ).fetchone()
        rows = (
            []
            if offset >= total
            else conn.execute(
                text(
                    "SELECT b.id, b.created_at, "
                    "e.id AS eid, e.title, e.description, e.starts_at, e.venue, "
                    "e.total_seats, e.total_seats - COUNT(ba.id) AS seats_left "
                    "FROM eventbook.bookings b "
                    "JOIN eventbook.events e ON e.id = b.event_id "
                    "LEFT JOIN eventbook.bookings ba "
                    "ON ba.event_id = e.id AND ba.cancelled_at IS NULL "
                    "WHERE b.user_id = :user_id AND b.cancelled_at IS NULL "
                    "GROUP BY b.id, e.id "
                    "ORDER BY b.created_at DESC, b.id DESC "
                    "LIMIT :limit OFFSET :offset"
                ),
                params,
            )
            .mappings()
            .all()
        )
    return envelope([_to_booking(row) for row in rows], page, page_size, total)


def cancel_booking(engine: Engine, actor: UserActor, booking_id: uuid.UUID) -> None:
    """Delete an owned future booking, freeing its seat; repeats return 404."""
    with engine.connect() as conn:
        located = conn.execute(
            text(
                "SELECT event_id FROM eventbook.bookings "
                "WHERE id = :booking_id AND user_id = :user_id"
            ),
            {"booking_id": str(booking_id), "user_id": str(actor.id)},
        ).scalar()
    if located is None:
        # Missing, already deleted with its event, or owned by someone else:
        # identical response either way discloses nothing.
        raise ApiError(404, "NOT_FOUND", "Booking not found.")
    with write_event(engine, uuid.UUID(str(located))) as (conn, event, now_db):
        booking = conn.execute(
            text(
                "SELECT id, cancelled_at FROM eventbook.bookings "
                "WHERE id = :booking_id AND user_id = :user_id"
            ),
            {"booking_id": str(booking_id), "user_id": str(actor.id)},
        ).mappings().fetchone()
        if booking is None or booking["cancelled_at"] is not None:
            raise ApiError(404, "NOT_FOUND", "Booking not found.")
        if event["starts_at"] <= now_db:
            raise ApiError(409, "EVENT_STARTED", "This event has already started.")
        conn.execute(
            text("DELETE FROM eventbook.bookings WHERE id = :booking_id"),
            {"booking_id": str(booking_id)},
        )


router = APIRouter(tags=["bookings"])


@router.post("/api/events/{event_id}/bookings", status_code=201, response_model=dict)
def create_booking(
    event_id: uuid.UUID,
    request: Request,
    actor: UserActor = Depends(require_non_admin),
) -> dict:
    settings: Settings = request.app.state.settings
    return book_seat(get_engine(settings), actor, event_id)


@router.get("/api/bookings/me", response_model=dict)
def my_bookings(
    request: Request,
    actor: UserActor = Depends(require_non_admin),
    page: int = DEFAULT_PAGE,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict:
    settings: Settings = request.app.state.settings
    return list_my_bookings(get_engine(settings), actor, page, page_size)


@router.delete("/api/bookings/{booking_id}", status_code=204, response_model=None)
def delete_booking(
    booking_id: uuid.UUID,
    request: Request,
    actor: UserActor = Depends(require_non_admin),
) -> None:
    settings: Settings = request.app.state.settings
    cancel_booking(get_engine(settings), actor, booking_id)
    return None

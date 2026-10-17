"""Admin event management and attendee lists (TASK-006).

Owns rules B5–B6 and the chosen deletion policy. Every mutation reuses
the shared event-first write protocol from `app.bookings`; capacity edits
are rejected below the active booking count, and deletion is rejected
while any active booking exists (past events included). Otherwise the
event is deleted and its cancelled history cascades. Started events are
read-only history: edits and deletion fail with EVENT_STARTED once the
start time has passed. All routes require an admin actor before any data
is disclosed.
"""

import re
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Request
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StrictInt, field_validator
from sqlalchemy import text
from sqlalchemy.engine import Engine

from .auth import UserActor, require_admin
from .bookings import write_event
from .config import Settings
from .db import get_engine
from .errors import ApiError
from .events import DEFAULT_TIME_FILTER, EventDetail, search_events, utc_z
from .pagination import DEFAULT_PAGE, DEFAULT_PAGE_SIZE, envelope, parse_pagination


def _trimmed(value: object) -> object:
    if isinstance(value, str):
        if "\x00" in value:
            raise ValueError("Must not contain NUL characters.")
        return value.strip()
    return value


_NUMERIC_RE = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)$")


def _string_timestamp(value: object) -> object:
    """Require timestamp strings with an explicit offset.

    Epoch numbers, floats, and numeric strings are rejected here;
    naive strings are rejected by AwareDatetime downstream.
    """
    if isinstance(value, str) and not _NUMERIC_RE.fullmatch(value.strip()):
        return value
    raise ValueError("Timestamp must be a string with an explicit timezone offset.")


class EventInput(BaseModel):
    """Full event payload for creation; unknown and null fields rejected."""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1, max_length=5000)
    starts_at: AwareDatetime
    venue: str = Field(min_length=1, max_length=300)
    total_seats: StrictInt = Field(ge=1, le=100000)

    @field_validator("title", "description", "venue", mode="before")
    @classmethod
    def _trim(cls, value: object) -> object:
        return _trimmed(value)

    @field_validator("starts_at", mode="before")
    @classmethod
    def _string_time(cls, value: object) -> object:
        return _string_timestamp(value)


class EventPatch(BaseModel):
    """Nonempty subset for edits; same bounds and rejections as creation."""

    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, min_length=1, max_length=5000)
    starts_at: AwareDatetime | None = None
    venue: str | None = Field(default=None, min_length=1, max_length=300)
    total_seats: StrictInt | None = Field(default=None, ge=1, le=100000)

    @field_validator("title", "description", "venue", mode="before")
    @classmethod
    def _trim(cls, value: object) -> object:
        return _trimmed(value)

    @field_validator("starts_at", mode="before")
    @classmethod
    def _string_time(cls, value: object) -> object:
        return _string_timestamp(value) if value is not None else value


class AttendeeUser(BaseModel):
    id: uuid.UUID
    email: str


class AttendeePublic(BaseModel):
    booking_id: uuid.UUID
    user: AttendeeUser
    booked_at: str


def _to_detail(
    event_id: uuid.UUID,
    title: str,
    description: str,
    starts_at: datetime,
    venue: str,
    total_seats: int,
    active: int,
) -> dict:
    return EventDetail(
        id=event_id,
        title=title,
        description=description,
        starts_at=utc_z(starts_at),
        venue=venue,
        total_seats=total_seats,
        seats_left=total_seats - active,
    ).model_dump(mode="json")


def _active_count(conn, event_id: str) -> int:  # type: ignore[no-untyped-def]
    (active,) = conn.execute(
        text(
            "SELECT count(*) FROM eventbook.bookings "
            "WHERE event_id = :event_id AND cancelled_at IS NULL"
        ),
        {"event_id": event_id},
    ).fetchone()
    return active


def create_event(engine: Engine, data: EventInput) -> dict:
    """Create an immediately-public event; raises ApiError never (validated)."""
    event_id = uuid.uuid4()
    with engine.begin() as conn:
        row = conn.execute(
            text(
                "INSERT INTO eventbook.events "
                "(id, title, description, starts_at, venue, total_seats) "
                "VALUES (:id, :title, :description, :starts_at, :venue, :total_seats) "
                "RETURNING id, title, description, starts_at, venue, total_seats"
            ),
            {
                "id": str(event_id),
                "title": data.title,
                "description": data.description,
                "starts_at": data.starts_at,
                "venue": data.venue,
                "total_seats": data.total_seats,
            },
        ).mappings().fetchone()
    assert row is not None
    return _to_detail(
        row["id"], row["title"], row["description"], row["starts_at"],
        row["venue"], row["total_seats"], 0,
    )


def update_event(engine: Engine, event_id: uuid.UUID, patch: EventPatch) -> dict:
    """Apply a validated nonempty subset under the event lock (B5 enforced)."""
    nulls = {
        name: "Must not be null."
        for name in patch.model_fields_set
        if getattr(patch, name) is None
    }
    if nulls:
        raise ApiError(422, "VALIDATION_ERROR", "Invalid input.", fields=nulls)
    changes = {
        name: getattr(patch, name)
        for name in patch.model_fields_set
        if getattr(patch, name) is not None
    }
    if not changes:
        raise ApiError(
            422, "VALIDATION_ERROR", "Invalid input.",
            fields={"body": "Provide at least one field to update."},
        )
    with write_event(engine, event_id) as (conn, event, now_db):
        # Started events are read-only history (user-selected edge-case
        # policy): no edits of any kind once the start time has passed.
        if event["starts_at"] <= now_db:
            raise ApiError(
                409,
                "EVENT_STARTED",
                "This event has already started and can no longer be changed.",
            )
        active = _active_count(conn, str(event_id))
        if "total_seats" in changes and changes["total_seats"] < active:
            raise ApiError(
                409,
                "CAPACITY_BELOW_BOOKINGS",
                "Total seats cannot be below the booked count.",
            )
        assignments = ", ".join(f"{name} = :{name}" for name in changes)
        row = conn.execute(
            text(
                "UPDATE eventbook.events SET "
                f"{assignments}, updated_at = :now WHERE id = :event_id "
                "RETURNING id, title, description, starts_at, venue, total_seats"
            ),
            {**changes, "now": now_db, "event_id": str(event_id)},
        ).mappings().fetchone()
    assert row is not None
    return _to_detail(
        row["id"], row["title"], row["description"], row["starts_at"],
        row["venue"], row["total_seats"], active,
    )


def delete_event(engine: Engine, event_id: uuid.UUID) -> None:
    """Delete when future with no active booking; cancelled history cascades.

    Started events are preserved as read-only history and past-event
    deletion is rejected even with zero bookings: no historical data is
    ever deleted or rewritten by this path.
    """
    with write_event(engine, event_id) as (conn, event, now_db):
        if event["starts_at"] <= now_db:
            raise ApiError(
                409,
                "EVENT_STARTED",
                "This event has already started and can no longer be deleted.",
            )
        active = _active_count(conn, str(event_id))
        if active > 0:
            raise ApiError(
                409,
                "EVENT_HAS_BOOKINGS",
                "Events with active bookings cannot be deleted.",
            )
        conn.execute(
            text("DELETE FROM eventbook.events WHERE id = :event_id"),
            {"event_id": str(event_id)},
        )


router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/events", response_model=dict)
def admin_list_events(
    request: Request,
    actor: UserActor = Depends(require_admin),
    q: str = "",
    time_filter: str = DEFAULT_TIME_FILTER,
    page: int = DEFAULT_PAGE,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict:
    _ = actor
    settings: Settings = request.app.state.settings
    return search_events(
        get_engine(settings), q=q, page=page, page_size=page_size,
        time_filter=time_filter, include_description=True,
    )


@router.post("/events", status_code=201, response_model=dict)
def admin_create_event(
    body: EventInput, request: Request, actor: UserActor = Depends(require_admin)
) -> dict:
    _ = actor
    settings: Settings = request.app.state.settings
    return create_event(get_engine(settings), body)


@router.patch("/events/{event_id}", response_model=dict)
def admin_update_event(
    event_id: uuid.UUID,
    body: EventPatch,
    request: Request,
    actor: UserActor = Depends(require_admin),
) -> dict:
    _ = actor
    settings: Settings = request.app.state.settings
    return update_event(get_engine(settings), event_id, body)


@router.delete("/events/{event_id}", status_code=204, response_model=None)
def admin_delete_event(
    event_id: uuid.UUID,
    request: Request,
    actor: UserActor = Depends(require_admin),
) -> None:
    _ = actor
    settings: Settings = request.app.state.settings
    delete_event(get_engine(settings), event_id)
    return None


@router.get("/events/{event_id}/attendees", response_model=dict)
def admin_list_attendees(
    event_id: uuid.UUID,
    request: Request,
    actor: UserActor = Depends(require_admin),
    page: int = DEFAULT_PAGE,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict:
    _ = actor
    settings: Settings = request.app.state.settings
    page, page_size = parse_pagination(page, page_size)
    offset = (page - 1) * page_size
    params: dict = {"event_id": str(event_id), "limit": page_size, "offset": offset}
    engine = get_engine(settings)
    with engine.begin() as conn:
        conn.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
        exists = conn.execute(
            text("SELECT id FROM eventbook.events WHERE id = :event_id"),
            params,
        ).scalar()
        if exists is None:
            raise ApiError(404, "NOT_FOUND", "Event not found.")
        (total,) = conn.execute(
            text(
                "SELECT count(*) FROM eventbook.bookings "
                "WHERE event_id = :event_id AND cancelled_at IS NULL"
            ),
            params,
        ).fetchone()
        rows = (
            []
            if offset >= total
            else conn.execute(
                text(
                    "SELECT b.id AS booking_id, b.created_at AS booked_at, "
                    "u.id AS user_id, u.email AS user_email "
                    "FROM eventbook.bookings b "
                    "JOIN eventbook.users u ON u.id = b.user_id "
                    "WHERE b.event_id = :event_id AND b.cancelled_at IS NULL "
                    "ORDER BY b.created_at ASC, b.id ASC "
                    "LIMIT :limit OFFSET :offset"
                ),
                params,
            )
            .mappings()
            .all()
        )
    items = [
        AttendeePublic(
            booking_id=row["booking_id"],
            user=AttendeeUser(id=row["user_id"], email=row["user_email"]),
            booked_at=utc_z(row["booked_at"]),
        ).model_dump(mode="json")
        for row in rows
    ]
    return envelope(items, page, page_size, total)

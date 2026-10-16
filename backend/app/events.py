"""Public event browsing: upcoming list and detail (TASK-004).

Owns title filtering, server-side pagination, and remaining-seat counts.
Listing shows upcoming events only; detail stays available for past
events. Counts and items share one short REPEATABLE READ transaction
with identical filters; seats come from one bounded aggregate per
request, never per-event queries or frontend slicing.
"""

import uuid
from datetime import timezone

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.engine import Engine

from .config import Settings
from .db import get_engine
from .errors import ApiError
from .pagination import DEFAULT_PAGE, DEFAULT_PAGE_SIZE, envelope, parse_pagination

MAX_QUERY_LENGTH = 200


class EventSummary(BaseModel):
    id: uuid.UUID
    title: str
    starts_at: str
    venue: str
    total_seats: int
    seats_left: int


class EventDetail(EventSummary):
    description: str


def utc_z(value) -> str:  # type: ignore[no-untyped-def]
    """Format a timestamptz value as an RFC 3339 UTC string with Z."""
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_search(raw: str) -> str | None:
    """Trim the title filter; empty means no filter, overlong is a 422."""
    if "\x00" in raw:
        raise ApiError(
            422,
            "VALIDATION_ERROR",
            "Invalid input.",
            fields={"q": "Search must not contain NUL characters."},
        )
    query = raw.strip()
    if not query:
        return None
    if len(query) > MAX_QUERY_LENGTH:
        raise ApiError(
            422,
            "VALIDATION_ERROR",
            "Invalid input.",
            fields={"q": f"Search must be at most {MAX_QUERY_LENGTH} characters."},
        )
    return query


def escape_like(fragment: str) -> str:
    """Escape LIKE metacharacters so search stays a literal substring."""
    return (
        fragment.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    )


router = APIRouter(prefix="/api/events", tags=["events"])

_UPCOMING_WHERE = "e.starts_at > now()"
_SEARCH_WHERE = " AND e.title ILIKE '%' || :pattern || '%' ESCAPE '\\'"


def search_events(
    engine: Engine,
    *,
    upcoming_only: bool,
    q: str,
    page: int,
    page_size: int,
) -> dict:
    """Filtered, paginated event summaries with seat counts.

    Count and items share one short REPEATABLE READ transaction with
    identical filters; seats come from a single bounded aggregate.
    """
    page, page_size = parse_pagination(page, page_size)
    query = parse_search(q)
    pattern = escape_like(query) if query is not None else None
    where = (_UPCOMING_WHERE if upcoming_only else "TRUE") + (
        _SEARCH_WHERE if pattern is not None else ""
    )
    offset = (page - 1) * page_size
    params: dict = {"limit": page_size, "offset": offset}
    if pattern is not None:
        params["pattern"] = pattern
    with engine.begin() as conn:
        conn.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
        (total,) = conn.execute(
            text(f"SELECT count(*) FROM eventbook.events e WHERE {where}"),
            params,
        ).fetchone()
        # Out-of-range pages return an empty collection per contract. The
        # count carries no OFFSET, so this also keeps extreme page numbers
        # (whose OFFSET would overflow PostgreSQL) away from the database.
        rows = (
            []
            if offset >= total
            else conn.execute(
                text(
                    "SELECT e.id, e.title, e.starts_at, e.venue, e.total_seats, "
                    "e.total_seats - COUNT(b.id) AS seats_left "
                    "FROM eventbook.events e "
                    "LEFT JOIN eventbook.bookings b "
                    "ON b.event_id = e.id AND b.cancelled_at IS NULL "
                    f"WHERE {where} "
                    "GROUP BY e.id "
                    "ORDER BY e.starts_at ASC, e.id ASC "
                    "LIMIT :limit OFFSET :offset"
                ),
                params,
            )
            .mappings()
            .all()
        )
    items = [
        EventSummary(
            id=row["id"],
            title=row["title"],
            starts_at=utc_z(row["starts_at"]),
            venue=row["venue"],
            total_seats=row["total_seats"],
            seats_left=row["seats_left"],
        ).model_dump(mode="json")
        for row in rows
    ]
    return envelope(items, page, page_size, total)


@router.get("", response_model=dict)
def list_events(
    request: Request, q: str = "", page: int = DEFAULT_PAGE, page_size: int = DEFAULT_PAGE_SIZE
) -> dict:
    settings: Settings = request.app.state.settings
    return search_events(get_engine(settings), upcoming_only=True, q=q, page=page, page_size=page_size)


@router.get("/{event_id}", response_model=dict)
def get_event(event_id: uuid.UUID, request: Request) -> dict:
    settings: Settings = request.app.state.settings
    engine = get_engine(settings)
    with engine.connect() as conn:
        row = conn.execute(
            text(
                "SELECT e.id, e.title, e.description, e.starts_at, e.venue, "
                "e.total_seats, e.total_seats - COUNT(b.id) AS seats_left "
                "FROM eventbook.events e "
                "LEFT JOIN eventbook.bookings b "
                "ON b.event_id = e.id AND b.cancelled_at IS NULL "
                "WHERE e.id = :event_id "
                "GROUP BY e.id"
            ),
            {"event_id": str(event_id)},
        ).mappings().fetchone()
    if row is None:
        raise ApiError(404, "NOT_FOUND", "Event not found.")
    return EventDetail(
        id=row["id"],
        title=row["title"],
        description=row["description"],
        starts_at=utc_z(row["starts_at"]),
        venue=row["venue"],
        total_seats=row["total_seats"],
        seats_left=row["seats_left"],
    ).model_dump(mode="json")

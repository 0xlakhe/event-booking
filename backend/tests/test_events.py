"""Public browsing tests against isolated PostgreSQL (TASK-004).

Exercises the HTTP interface with no authentication: upcoming filtering,
remaining seats from active rows only, literal title search, server-side
pagination boundaries, stable ordering, and detail availability for past
events. Fixtures are committed rows arranged per test, never clock mocks.
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


def _make_event(
    cur: psycopg.Cursor,
    title: str,
    days_ahead: float,
    total_seats: int = 10,
    venue: str = "Hall",
) -> str:
    cur.execute(
        "INSERT INTO eventbook.events (id, title, description, starts_at, venue, total_seats) "
        "VALUES (%s, %s, %s, now() + make_interval(days => %s), %s, %s) RETURNING id",
        (str(uuid.uuid4()), title, f"About {title}.", days_ahead, venue, total_seats),
    )
    return str(cur.fetchone()[0])


def _make_user(cur: psycopg.Cursor) -> str:
    email = f"ev-{uuid.uuid4().hex[:12]}@example.com"
    cur.execute(
        "INSERT INTO eventbook.users (id, email, password_hash) VALUES (%s, %s, %s) RETURNING id",
        (str(uuid.uuid4()), email, "x"),
    )
    return str(cur.fetchone()[0])


def _book(cur: psycopg.Cursor, user_id: str, event_id: str, cancelled: bool = False) -> None:
    cur.execute(
        "INSERT INTO eventbook.bookings (id, user_id, event_id, cancelled_at) "
        "VALUES (%s, %s, %s, CASE WHEN %s THEN now() ELSE NULL END)",
        (str(uuid.uuid4()), user_id, event_id, cancelled),
    )


def test_upcoming_only_and_past_detail_available(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        future_a = _make_event(cur, "Future A", 5)
        _make_event(cur, "Future B", 6)
        past = _make_event(cur, "Past C", -5)
        db.commit()
    listing = api.get("/api/events")
    assert listing.status_code == 200, listing.text
    body = listing.json()
    assert body["total"] == 2
    assert {item["title"] for item in body["items"]} == {"Future A", "Future B"}
    for item in body["items"]:
        assert set(item) == {"id", "title", "starts_at", "venue", "total_seats", "seats_left"}

    detail = api.get(f"/api/events/{past}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["title"] == "Past C"
    assert "description" in detail.json()

    future = api.get(f"/api/events/{future_a}")
    assert future.status_code == 200
    assert future.json()["title"] == "Future A"


def test_seats_left_counts_active_only(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        event_id = _make_event(cur, "Roomy", 9, total_seats=5)
        _book(cur, _make_user(cur), event_id)
        _book(cur, _make_user(cur), event_id)
        _book(cur, _make_user(cur), event_id, cancelled=True)
        db.commit()
    body = api.get("/api/events").json()
    assert body["total"] == 1
    assert body["items"][0]["seats_left"] == 3
    assert body["items"][0]["total_seats"] == 5
    assert api.get(f"/api/events/{event_id}").json()["seats_left"] == 3


def test_search_is_case_insensitive_literal(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        _make_event(cur, "Kathmandu Music Night", 3)
        _make_event(cur, "kathmandu food fest", 4)
        _make_event(cur, "100% organic fair", 5)
        _make_event(cur, "100X organic decoy", 6)
        _make_event(cur, "under_score night", 7)
        _make_event(cur, "underXscore decoy", 8)
        _make_event(cur, "back\\slash gig", 9)
        db.commit()

    music = api.get("/api/events", params={"q": "music"}).json()
    assert {i["title"] for i in music["items"]} == {"Kathmandu Music Night"}

    food = api.get("/api/events", params={"q": "  FOOD "}).json()
    assert [i["title"] for i in food["items"]] == ["kathmandu food fest"]

    percent = api.get("/api/events", params={"q": "100%"}).json()
    assert [i["title"] for i in percent["items"]] == ["100% organic fair"]

    underscore = api.get("/api/events", params={"q": "under_score"}).json()
    assert [i["title"] for i in underscore["items"]] == ["under_score night"]

    backslash = api.get("/api/events", params={"q": "back\\slash"}).json()
    assert [i["title"] for i in backslash["items"]] == ["back\\slash gig"]


def test_pagination_boundaries_and_envelope(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        for day in range(1, 6):
            _make_event(cur, f"Paginated {day:02d}", day)
        db.commit()

    first = api.get("/api/events", params={"page": 1, "page_size": 2}).json()
    assert (first["page"], first["page_size"], first["total"]) == (1, 2, 5)
    assert [i["title"] for i in first["items"]] == ["Paginated 01", "Paginated 02"]
    third = api.get("/api/events", params={"page": 3, "page_size": 2}).json()
    assert [i["title"] for i in third["items"]] == ["Paginated 05"]
    past_end = api.get("/api/events", params={"page": 9, "page_size": 2}).json()
    assert past_end["items"] == [] and past_end["total"] == 5

    for params in ({"page": 0}, {"page_size": 0}, {"page_size": 51}):
        resp = api.get("/api/events", params=params)
        assert resp.status_code == 422, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    bad_q = api.get("/api/events", params={"q": "x" * 201})
    assert bad_q.status_code == 422
    assert bad_q.json()["error"]["fields"]["q"]
    bad_page = api.get("/api/events", params={"page": "abc"})
    assert bad_page.status_code == 422
    assert bad_page.json()["error"]["code"] == "VALIDATION_ERROR"


def test_stable_ordering_and_shapes(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        _make_event(cur, "Later", 20, venue="Venue B")
        _make_event(cur, "Sooner", 10, venue="Venue A")
        db.commit()
    body = api.get("/api/events").json()
    assert [i["title"] for i in body["items"]] == ["Sooner", "Later"]
    assert set(body) == {"items", "page", "page_size", "total"}
    first = body["items"][0]
    assert first["starts_at"].endswith("Z")
    assert isinstance(first["id"], str) and isinstance(first["seats_left"], int)


def test_detail_404_and_invalid_uuid(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        _make_event(cur, "Only", 2)
        db.commit()
    missing = api.get(f"/api/events/{uuid.uuid4()}")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "NOT_FOUND"
    invalid = api.get("/api/events/not-a-uuid")
    assert invalid.status_code == 422
    assert invalid.json()["error"]["code"] == "VALIDATION_ERROR"


def test_extreme_page_returns_empty_collection(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        _make_event(cur, "Only", 2)
        db.commit()
    for params in ({"page": 10**12}, {"page": 10**12, "page_size": 50}):
        resp = api.get("/api/events", params=params)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["items"] == [] and body["total"] == 1
        assert body["page"] == params["page"]


def test_nul_search_rejected_before_query(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    with db.cursor() as cur:
        _make_event(cur, "Only", 2)
        db.commit()
    for query in ("a\x00b", "\x00"):
        resp = api.get("/api/events", params={"q": query})
        assert resp.status_code == 422, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
        assert resp.json()["error"]["fields"]["q"]

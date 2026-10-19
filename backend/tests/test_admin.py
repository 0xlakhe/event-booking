"""Admin contract tests against isolated PostgreSQL (TASK-006, B5–B6).

Exercises the HTTP interface as admin, normal user, and anonymous caller:
permission denial on every admin route, input validation, capacity rules,
attendee privacy, past-event handling, and the deletion policy. Final
database state is asserted after every rejection.
"""

import os
import uuid
from datetime import datetime, timedelta, timezone

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
    return f"adm-{uuid.uuid4().hex[:12]}@example.com"


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _register_login(api: TestClient, email: str) -> str:
    assert api.post(
        "/api/auth/register", json={"email": email, "password": "password-123"}
    ).status_code == 201
    login = api.post("/api/auth/login", json={"email": email, "password": "password-123"})
    assert login.status_code == 200, login.text
    return login.json()["access_token"]


def _make_admin(api: TestClient, db: psycopg.Connection) -> str:
    email = _email()
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


def _future(days: int = 30) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


def _event_body(**overrides) -> dict:
    body = {
        "title": "Admin Event",
        "description": "Created through the admin API.",
        "starts_at": _future(),
        "venue": "Hall A",
        "total_seats": 20,
    }
    body.update(overrides)
    return body


def _create_event(api: TestClient, token: str, **overrides) -> dict:
    resp = api.post("/api/admin/events", json=_event_body(**overrides), headers=_auth(token))
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_admin_routes_reject_unauthenticated_and_normal_users(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin = _make_admin(api, db)
    event_id = _create_event(api, admin)["id"]
    user = _register_login(api, _email())
    user_headers = _auth(user)

    probes = [
        ("GET", "/api/admin/events", None),
        ("POST", "/api/admin/events", _event_body(title="X")),
        ("PATCH", f"/api/admin/events/{event_id}", {"title": "Y"}),
        ("DELETE", f"/api/admin/events/{event_id}", None),
        ("GET", f"/api/admin/events/{event_id}/attendees", None),
    ]
    for method, path, body in probes:
        anon = api.request(method, path, json=body)
        assert anon.status_code == 401, (method, path, anon.text)
        assert anon.json()["error"]["code"] == "AUTH_REQUIRED"
        denied = api.request(method, path, json=body, headers=user_headers)
        assert denied.status_code == 403, (method, path, denied.text)
        assert denied.json()["error"]["code"] == "ADMIN_REQUIRED"
    # The probes changed nothing.
    assert api.get(f"/api/events/{event_id}").status_code == 200


def test_create_event_validates_input(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin_headers = _auth(_make_admin(api, db))
    missing_title = {k: v for k, v in _event_body().items() if k != "title"}
    missing_venue = {k: v for k, v in _event_body().items() if k != "venue"}
    bad_bodies = [
        missing_title,
        missing_venue,
        {**_event_body(), "title": "   "},
        {**_event_body(), "title": "t" * 201},
        {**_event_body(), "description": ""},
        {**_event_body(), "starts_at": "2030-01-01T10:00:00"},
        {**_event_body(), "total_seats": 0},
        {**_event_body(), "total_seats": 100001},
        {**_event_body(), "total_seats": "many"},
        {**_event_body(), "total_seats": 2.5},
        {**_event_body(), "title": None},
        {**_event_body(), "owner": "someone"},
    ]
    for body in bad_bodies:
        resp = api.post("/api/admin/events", json=body, headers=admin_headers)
        assert resp.status_code == 422, (body, resp.text)
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    assert api.get("/api/admin/events", headers=admin_headers).json()["total"] == 0

    trimmed = api.post(
        "/api/admin/events",
        json=_event_body(title="  Spaced Title  "),
        headers=admin_headers,
    )
    assert trimmed.status_code == 201
    assert trimmed.json()["title"] == "Spaced Title"

    past = api.post(
        "/api/admin/events",
        json=_event_body(title="Past Show", starts_at="2020-01-01T10:00:00+00:00"),
        headers=admin_headers,
    )
    assert past.status_code == 201
    assert past.json()["seats_left"] == past.json()["total_seats"]


def test_created_event_immediately_public(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin = _make_admin(api, db)
    created = _create_event(api, admin, title="Fresh Public")
    listing = api.get("/api/events", params={"q": "Fresh Public"}).json()
    assert listing["total"] == 1
    assert listing["items"][0]["id"] == created["id"]
    detail = api.get(f"/api/events/{created['id']}")
    assert detail.status_code == 200
    assert detail.json()["description"] == created["description"]


def test_admin_list_includes_past_and_search(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin = _make_admin(api, db)
    admin_headers = _auth(admin)
    _create_event(api, admin, title="Gala Future")
    api.post(
        "/api/admin/events",
        json=_event_body(title="Gala Past", starts_at="2020-05-05T10:00:00+00:00"),
        headers=admin_headers,
    )
    body = api.get(
        "/api/admin/events", params={"time_filter": "all"}, headers=admin_headers
    ).json()
    assert body["total"] == 2
    assert {i["title"] for i in body["items"]} == {"Gala Future", "Gala Past"}
    assert set(body) == {"items", "page", "page_size", "total"}
    searched = api.get(
        "/api/admin/events", params={"q": "gala", "time_filter": "all"}, headers=admin_headers
    ).json()
    assert searched["total"] == 2
    public = api.get("/api/events", params={"q": "gala"}).json()
    assert public["total"] == 1


def test_admin_time_filter_membership_search_totals_and_order(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin = _make_admin(api, db)
    admin_headers = _auth(admin)
    now = datetime.now(timezone.utc)
    _create_event(api, admin, title="Alpha Future Far", starts_at=_future(30))
    _create_event(api, admin, title="Alpha Future Near", starts_at=_future(5))
    for title, days in (("Alpha Past Recent", 1), ("Alpha Past Old", 10)):
        resp = api.post(
            "/api/admin/events",
            json=_event_body(title=title, starts_at=(now - timedelta(days=days)).isoformat()),
            headers=admin_headers,
        )
        assert resp.status_code == 201, resp.text

    upcoming = api.get(
        "/api/admin/events", params={"time_filter": "upcoming"}, headers=admin_headers
    ).json()
    assert upcoming["total"] == 2
    assert [i["title"] for i in upcoming["items"]] == ["Alpha Future Near", "Alpha Future Far"]

    past = api.get(
        "/api/admin/events", params={"time_filter": "past"}, headers=admin_headers
    ).json()
    assert past["total"] == 2
    assert [i["title"] for i in past["items"]] == ["Alpha Past Recent", "Alpha Past Old"]

    all_events = api.get(
        "/api/admin/events", params={"time_filter": "all"}, headers=admin_headers
    ).json()
    assert all_events["total"] == 4
    # All lists the upcoming block first then the past block.
    assert [i["title"] for i in all_events["items"]] == [
        "Alpha Future Near",
        "Alpha Future Far",
        "Alpha Past Recent",
        "Alpha Past Old",
    ]

    # Search combines with each filter using the same conditions.
    assert api.get(
        "/api/admin/events", params={"q": "future", "time_filter": "upcoming"}, headers=admin_headers
    ).json()["total"] == 2
    assert api.get(
        "/api/admin/events", params={"q": "future", "time_filter": "past"}, headers=admin_headers
    ).json()["total"] == 0
    assert api.get(
        "/api/admin/events", params={"q": "past", "time_filter": "all"}, headers=admin_headers
    ).json()["total"] == 2

    # Upcoming is the default.
    assert api.get("/api/admin/events", headers=admin_headers).json()["total"] == 2

    # Unknown filter values are a 422 field error.
    bad = api.get("/api/admin/events", params={"time_filter": "bogus"}, headers=admin_headers)
    assert bad.status_code == 422
    assert bad.json()["error"]["code"] == "VALIDATION_ERROR"
    assert bad.json()["error"]["fields"]["time_filter"]

    # The public listing is unchanged: it stays upcoming-only and ignores
    # an extra filter argument rather than exposing past events.
    public = api.get("/api/events", params={"time_filter": "past"}).json()
    assert public["total"] == 2
    assert all("Future" in i["title"] for i in public["items"])


def test_admin_time_filter_boundary_now_is_past(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin = _make_admin(api, db)
    admin_headers = _auth(admin)
    event_id = _create_event(api, admin, title="Edge", starts_at=_future(1))["id"]
    with db.cursor() as cur:
        cur.execute("UPDATE eventbook.events SET starts_at = now() WHERE id = %s", (event_id,))
        db.commit()
    # starts_at == database now() satisfies `<= now()` (past) and never
    # `> now()` (upcoming), so the boundary belongs to Past.
    upcoming = api.get(
        "/api/admin/events", params={"time_filter": "upcoming"}, headers=admin_headers
    ).json()
    past = api.get(
        "/api/admin/events", params={"time_filter": "past"}, headers=admin_headers
    ).json()
    assert upcoming["total"] == 0
    assert past["total"] == 1
    assert past["items"][0]["title"] == "Edge"


def test_admin_time_filter_pagination_totals(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin = _make_admin(api, db)
    admin_headers = _auth(admin)
    for index in range(3):
        _create_event(api, admin, title=f"Upcoming {index}", starts_at=_future(10 + index))
    past_day = datetime.now(timezone.utc) - timedelta(days=1)
    for index in range(2):
        resp = api.post(
            "/api/admin/events",
            json=_event_body(
                title=f"Past {index}",
                starts_at=(past_day - timedelta(days=index)).isoformat(),
            ),
            headers=admin_headers,
        )
        assert resp.status_code == 201, resp.text

    first = api.get(
        "/api/admin/events",
        params={"time_filter": "upcoming", "page_size": 2, "page": 1},
        headers=admin_headers,
    ).json()
    assert (first["total"], len(first["items"])) == (3, 2)
    second = api.get(
        "/api/admin/events",
        params={"time_filter": "upcoming", "page_size": 2, "page": 2},
        headers=admin_headers,
    ).json()
    assert (second["total"], len(second["items"])) == (3, 1)

    all_page = api.get(
        "/api/admin/events",
        params={"time_filter": "all", "page_size": 2, "page": 1},
        headers=admin_headers,
    ).json()
    assert (all_page["total"], len(all_page["items"])) == (5, 2)

    past_only = api.get(
        "/api/admin/events", params={"time_filter": "past"}, headers=admin_headers
    ).json()
    assert past_only["total"] == 2
    assert all(item["title"].startswith("Past") for item in past_only["items"])


def test_admin_time_filter_id_tiebreak(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    """Equal start times fall back to id, ascending for upcoming and
    descending for past, including the all view's two blocks."""
    _ = clean_db
    admin = _make_admin(api, db)
    admin_headers = _auth(admin)
    shared_future = _future(20)
    shared_past = (datetime.now(timezone.utc) - timedelta(days=20)).isoformat()
    future = [
        _create_event(api, admin, title=f"F{index}", starts_at=shared_future)["id"]
        for index in range(2)
    ]
    past = [
        _create_event(api, admin, title=f"P{index}", starts_at=shared_past)["id"]
        for index in range(2)
    ]

    upcoming_ids = [
        item["id"]
        for item in api.get(
            "/api/admin/events", params={"time_filter": "upcoming"}, headers=admin_headers
        ).json()["items"]
    ]
    assert upcoming_ids == sorted(future)

    past_ids = [
        item["id"]
        for item in api.get(
            "/api/admin/events", params={"time_filter": "past"}, headers=admin_headers
        ).json()["items"]
    ]
    assert past_ids == sorted(past, reverse=True)

    all_ids = [
        item["id"]
        for item in api.get(
            "/api/admin/events", params={"time_filter": "all"}, headers=admin_headers
        ).json()["items"]
    ]
    assert all_ids == sorted(future) + sorted(past, reverse=True)


def test_admin_list_descriptions_are_paginated_without_per_event_queries(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    from sqlalchemy import event
    from sqlalchemy.engine import Engine

    _ = clean_db
    admin = _make_admin(api, db)
    _create_event(api, admin, title="First", description="First description.", starts_at=_future(10))
    _create_event(api, admin, title="Second", description="Second description.", starts_at=_future(20))
    statements: list[str] = []

    def record_query(conn, cursor, statement, parameters, context, executemany):
        if "FROM eventbook.events e" in statement:
            statements.append(statement)

    event.listen(Engine, "before_cursor_execute", record_query)
    try:
        response = api.get("/api/admin/events", headers=_auth(admin), params={"page_size": 1, "page": 2})
    finally:
        event.remove(Engine, "before_cursor_execute", record_query)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert (body["page"], body["page_size"], body["total"]) == (2, 1, 2)
    assert len(body["items"]) == 1
    assert body["items"][0]["description"] == "Second description."
    assert len(statements) == 2
    public = api.get("/api/events").json()
    assert all("description" not in item for item in public["items"])


def test_capacity_below_active_rejected_equal_allowed(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin = _make_admin(api, db)
    admin_headers = _auth(admin)
    event_id = _create_event(api, admin, total_seats=3)["id"]
    first, second = _register_login(api, _email()), _register_login(api, _email())
    api.post(f"/api/events/{event_id}/bookings", headers=_auth(first))
    api.post(f"/api/events/{event_id}/bookings", headers=_auth(second))
    before = api.get(f"/api/events/{event_id}").json()

    low = api.patch(
        f"/api/admin/events/{event_id}", json={"total_seats": 1}, headers=admin_headers
    )
    assert low.status_code == 409
    assert low.json()["error"]["code"] == "CAPACITY_BELOW_BOOKINGS"
    after = api.get(f"/api/events/{event_id}").json()
    assert after["total_seats"] == 3 and after["seats_left"] == before["seats_left"]

    equal = api.patch(
        f"/api/admin/events/{event_id}", json={"total_seats": 2}, headers=admin_headers
    )
    assert equal.status_code == 200, equal.text
    assert equal.json()["total_seats"] == 2 and equal.json()["seats_left"] == 0


def test_attendees_active_only_and_private(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin = _make_admin(api, db)
    admin_headers = _auth(admin)
    event_id = _create_event(api, admin, total_seats=10)["id"]
    first, second, third = (_register_login(api, _email()) for _ in range(3))
    api.post(f"/api/events/{event_id}/bookings", headers=_auth(first))
    api.post(f"/api/events/{event_id}/bookings", headers=_auth(second))
    cancelled_id = api.post(f"/api/events/{event_id}/bookings", headers=_auth(third)).json()["id"]
    api.delete(f"/api/bookings/{cancelled_id}", headers=_auth(third))

    attendees = api.get(f"/api/admin/events/{event_id}/attendees", headers=admin_headers)
    assert attendees.status_code == 200, attendees.text
    body = attendees.json()
    assert body["total"] == 2
    for entry in body["items"]:
        assert set(entry) == {"booking_id", "user", "booked_at"}
        assert set(entry["user"]) == {"id", "email"}
    assert "password_hash" not in attendees.text and "token" not in attendees.text
    assert body["items"][0]["booked_at"] <= body["items"][1]["booked_at"]

    one_page = api.get(
        f"/api/admin/events/{event_id}/attendees",
        params={"page": 2, "page_size": 1},
        headers=admin_headers,
    ).json()
    assert one_page["total"] == 2 and len(one_page["items"]) == 1

    user_headers = _auth(_register_login(api, _email()))
    assert api.get(f"/api/admin/events/{event_id}/attendees", headers=user_headers).status_code == 403
    assert api.get(f"/api/admin/events/{event_id}/attendees").status_code == 401
    assert api.get(f"/api/admin/events/{uuid.uuid4()}/attendees", headers=admin_headers).status_code == 404


def test_delete_rejects_active_including_past(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin = _make_admin(api, db)
    admin_headers = _auth(admin)
    event_id = _create_event(api, admin)["id"]
    token = _register_login(api, _email())
    api.post(f"/api/events/{event_id}/bookings", headers=_auth(token))

    refused = api.delete(f"/api/admin/events/{event_id}", headers=admin_headers)
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "EVENT_HAS_BOOKINGS"
    assert api.get(f"/api/events/{event_id}").status_code == 200

    with db.cursor() as cur:
        cur.execute(
            "UPDATE eventbook.events SET starts_at = now() - interval '1 hour' WHERE id = %s",
            (event_id,),
        )
        db.commit()
    past_refused = api.delete(f"/api/admin/events/{event_id}", headers=admin_headers)
    assert past_refused.status_code == 409
    # Started-dominance: the read-only time check runs before the
    # active-booking check, so the code stays EVENT_STARTED here.
    assert past_refused.json()["error"]["code"] == "EVENT_STARTED"
    assert api.get(f"/api/events/{event_id}").status_code == 200


def test_delete_after_cancellation_cascades_history(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin = _make_admin(api, db)
    admin_headers = _auth(admin)
    event_id = _create_event(api, admin)["id"]
    for _ in range(2):
        token = _register_login(api, _email())
        booking_id = api.post(f"/api/events/{event_id}/bookings", headers=_auth(token)).json()["id"]
        api.delete(f"/api/bookings/{booking_id}", headers=_auth(token))
    assert api.delete(f"/api/admin/events/{event_id}", headers=admin_headers).status_code == 204
    assert api.get(f"/api/events/{event_id}").status_code == 404
    assert api.get(f"/api/admin/events/{event_id}/attendees", headers=admin_headers).status_code == 404
    with db.cursor() as cur:
        (events,) = cur.execute(
            "SELECT count(*) FROM eventbook.events WHERE id = %s", (event_id,)
        ).fetchone()
        (bookings,) = cur.execute(
            "SELECT count(*) FROM eventbook.bookings WHERE event_id = %s", (event_id,)
        ).fetchone()
        assert (events, bookings) == (0, 0)


def test_edit_to_past_blocks_later_booking(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin = _make_admin(api, db)
    admin_headers = _auth(admin)
    event_id = _create_event(api, admin, total_seats=5)["id"]
    moved = api.patch(
        f"/api/admin/events/{event_id}",
        json={"starts_at": "2020-02-02T10:00:00+00:00"},
        headers=admin_headers,
    )
    assert moved.status_code == 200
    late = api.post(
        f"/api/events/{event_id}/bookings", headers=_auth(_register_login(api, _email()))
    )
    assert late.status_code == 409
    assert late.json()["error"]["code"] == "EVENT_STARTED"


def test_patch_empty_and_null_rejected(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin_headers = _auth(_make_admin(api, db))
    event_id = api.post("/api/admin/events", json=_event_body(), headers=admin_headers).json()["id"]
    for body in ({}, {"title": None}, {"total_seats": "many"}):
        resp = api.patch(f"/api/admin/events/{event_id}", json=body, headers=admin_headers)
        assert resp.status_code == 422, (body, resp.text)
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    assert api.get(f"/api/events/{event_id}").json()["title"] == "Admin Event"


def test_admin_update_serialization(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin_headers = _auth(_make_admin(api, db))
    event_id = _create_event(api, _make_admin(api, db), total_seats=8)["id"]
    updated = api.patch(
        f"/api/admin/events/{event_id}",
        json={"title": "Renamed", "venue": "New Hall"},
        headers=admin_headers,
    )
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert set(body) == {"id", "title", "description", "starts_at", "venue", "total_seats", "seats_left"}
    assert (body["title"], body["venue"]) == ("Renamed", "New Hall")
    assert body["starts_at"].endswith("Z") and isinstance(body["id"], str)


def test_admin_responses_are_not_storeable(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin_headers = _auth(_make_admin(api, db))
    created = api.post("/api/admin/events", json=_event_body(), headers=admin_headers)
    assert created.status_code == 201
    assert created.headers.get("cache-control") == "no-store"
    event_id = created.json()["id"]
    routes = [
        ("GET", "/api/admin/events", 200),
        ("GET", f"/api/admin/events/{event_id}/attendees", 200),
        ("PATCH", f"/api/admin/events/{event_id}", 200),
    ]
    for method, path, status in routes:
        resp = api.request(
            method, path,
            json={"title": "Kept"} if method == "PATCH" else None,
            headers=admin_headers,
        )
        assert resp.status_code == status, (method, path, resp.text)
        assert resp.headers.get("cache-control") == "no-store", (method, path)
    missing = api.get(f"/api/admin/events/{uuid.uuid4()}/attendees", headers=admin_headers)
    assert missing.status_code == 404
    assert missing.headers.get("cache-control") == "no-store"


def test_patch_rejects_unknown_naive_and_trims(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin_headers = _auth(_make_admin(api, db))
    event_id = api.post("/api/admin/events", json=_event_body(), headers=admin_headers).json()["id"]
    for body in ({"unknown": 1}, {"starts_at": "2030-01-01T10:00:00"}):
        resp = api.patch(f"/api/admin/events/{event_id}", json=body, headers=admin_headers)
        assert resp.status_code == 422, (body, resp.text)
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    trimmed = api.patch(
        f"/api/admin/events/{event_id}", json={"title": "  Spaced  "}, headers=admin_headers
    )
    assert trimmed.status_code == 200
    assert trimmed.json()["title"] == "Spaced"


def test_create_rejects_remaining_bounds(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin_headers = _auth(_make_admin(api, db))
    bad_bodies = [
        {**_event_body(), "description": "x" * 5001},
        {**_event_body(), "venue": "v" * 301},
        {**_event_body(), "venue": "   "},
        {**_event_body(), "description": "   "},
        {**_event_body(), "total_seats": True},
    ]
    for body in bad_bodies:
        resp = api.post("/api/admin/events", json=body, headers=admin_headers)
        assert resp.status_code == 422, (body, resp.text)
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_admin_pagination_and_query_bounds(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin_headers = _auth(_make_admin(api, db))
    event_id = api.post("/api/admin/events", json=_event_body(), headers=admin_headers).json()["id"]
    for params in ({"page": 0}, {"page_size": 0}, {"page_size": 51}):
        for path in ("/api/admin/events", f"/api/admin/events/{event_id}/attendees"):
            resp = api.get(path, params=params, headers=admin_headers)
            assert resp.status_code == 422, (path, params, resp.text)
    # Only the listing routes accept `q`; extra query args elsewhere are
    # ignored by FastAPI routing, so bounds apply to the list endpoint.
    overlong = api.get("/api/admin/events", params={"q": "x" * 201}, headers=admin_headers)
    assert overlong.status_code == 422
    nul = api.get("/api/admin/events", params={"q": "a\x00b"}, headers=admin_headers)
    assert nul.status_code == 422
    assert nul.json()["error"]["fields"]["q"]


def test_non_admin_random_uuid_probes_denied(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin_headers = _auth(_make_admin(api, db))
    user_headers = _auth(_register_login(api, _email()))
    missing = str(uuid.uuid4())
    for method, path in (
        ("PATCH", f"/api/admin/events/{missing}"),
        ("DELETE", f"/api/admin/events/{missing}"),
    ):
        denied = api.request(method, path, json={"title": "X"} if method == "PATCH" else None,
                             headers=user_headers)
        assert denied.status_code == 403, (method, denied.text)
        assert denied.json()["error"]["code"] == "ADMIN_REQUIRED"
    assert api.patch(
        f"/api/admin/events/{missing}", json={"title": "X"}, headers=admin_headers
    ).status_code == 404
    assert api.delete(f"/api/admin/events/{missing}", headers=admin_headers).status_code == 404


def test_capacity_edit_on_past_event(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin = _make_admin(api, db)
    admin_headers = _auth(admin)
    event_id = _create_event(api, admin, total_seats=3)["id"]
    for _ in range(2):
        token = _register_login(api, _email())
        api.post(f"/api/events/{event_id}/bookings", headers=_auth(token))
    with db.cursor() as cur:
        cur.execute(
            "UPDATE eventbook.events SET starts_at = now() - interval '1 hour' WHERE id = %s",
            (event_id,),
        )
        db.commit()
    low = api.patch(
        f"/api/admin/events/{event_id}", json={"total_seats": 1}, headers=admin_headers
    )
    assert low.status_code == 409
    # Started events are read-only history: the time check dominates any
    # capacity outcome, so even a below-count edit reports EVENT_STARTED.
    assert low.json()["error"]["code"] == "EVENT_STARTED"
    equal = api.patch(
        f"/api/admin/events/{event_id}", json={"total_seats": 2}, headers=admin_headers
    )
    assert equal.status_code == 409
    assert equal.json()["error"]["code"] == "EVENT_STARTED"


def test_attendee_timestamp_format_and_tiebreak(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin_headers = _auth(_make_admin(api, db))
    event_id = api.post("/api/admin/events", json=_event_body(), headers=admin_headers).json()["id"]
    for _ in range(2):
        token = _register_login(api, _email())
        api.post(f"/api/events/{event_id}/bookings", headers=_auth(token))
    with db.cursor() as cur:
        cur.execute(
            "UPDATE eventbook.bookings SET created_at = '2030-01-01T00:00:00+00:00' "
            "WHERE event_id = %s",
            (event_id,),
        )
        db.commit()
    items = api.get(
        f"/api/admin/events/{event_id}/attendees", headers=admin_headers
    ).json()["items"]
    assert len(items) == 2
    assert all(item["booked_at"].endswith("Z") for item in items)
    assert items[0]["booking_id"] < items[1]["booking_id"]


def test_admin_rejects_epoch_timestamps_and_nul_text(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin_headers = _auth(_make_admin(api, db))
    event_id = api.post("/api/admin/events", json=_event_body(), headers=admin_headers).json()["id"]
    epoch_bodies = [
        {**_event_body(), "starts_at": 1754000000},
        {**_event_body(), "starts_at": "1754000000"},
        {**_event_body(), "starts_at": 1754000000.5},
    ]
    nul_bodies = [
        {**_event_body(), "title": "a\x00b"},
        {**_event_body(), "description": "a\x00b"},
        {**_event_body(), "venue": "a\x00b"},
    ]
    for body in epoch_bodies + nul_bodies:
        resp = api.post("/api/admin/events", json=body, headers=admin_headers)
        assert resp.status_code == 422, (body, resp.text)
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    for body in (
        {"starts_at": 1754000000},
        {"starts_at": "1754000000"},
        {"title": "a\x00b"},
        {"description": "a\x00b"},
        {"venue": "a\x00b"},
    ):
        resp = api.patch(f"/api/admin/events/{event_id}", json=body, headers=admin_headers)
        assert resp.status_code == 422, (body, resp.text)
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    assert api.get(f"/api/events/{event_id}").json()["title"] == "Admin Event"


def test_admin_cannot_edit_or_delete_started_event(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin_headers = _auth(_make_admin(api, db))
    event_id = api.post("/api/admin/events", json=_event_body(), headers=admin_headers).json()["id"]
    with db.cursor() as cur:
        cur.execute(
            "UPDATE eventbook.events SET starts_at = now() - interval '1 hour' WHERE id = %s",
            (event_id,),
        )
        db.commit()
    for body in ({"title": "Rewritten"}, {"total_seats": 50}):
        resp = api.patch(f"/api/admin/events/{event_id}", json=body, headers=admin_headers)
        assert resp.status_code == 409, (body, resp.text)
        assert resp.json()["error"]["code"] == "EVENT_STARTED"
    gone = api.delete(f"/api/admin/events/{event_id}", headers=admin_headers)
    assert gone.status_code == 409
    assert gone.json()["error"]["code"] == "EVENT_STARTED"
    kept = api.get(f"/api/events/{event_id}").json()
    assert kept["title"] == "Admin Event" and kept["total_seats"] == 20


def test_attendees_stay_readable_on_started_event(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    """Attendee reads have no time gate: active bookings on a started
    event remain visible to admins (read-only history stays readable)."""
    _ = clean_db
    admin_headers = _auth(_make_admin(api, db))
    event_id = _create_event(api, _make_admin(api, db))["id"]
    token = _register_login(api, _email())
    api.post(f"/api/events/{event_id}/bookings", headers=_auth(token))
    with db.cursor() as cur:
        cur.execute(
            "UPDATE eventbook.events SET starts_at = now() - interval '1 hour' WHERE id = %s",
            (event_id,),
        )
        db.commit()
    attendees = api.get(f"/api/admin/events/{event_id}/attendees", headers=admin_headers)
    assert attendees.status_code == 200, attendees.text
    body = attendees.json()
    assert body["total"] == 1
    assert set(body["items"][0]["user"]) == {"id", "email"}


def test_admin_start_time_boundary_rejects(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    _ = clean_db
    admin_headers = _auth(_make_admin(api, db))
    event_id = api.post("/api/admin/events", json=_event_body(), headers=admin_headers).json()["id"]
    with db.cursor() as cur:
        cur.execute("UPDATE eventbook.events SET starts_at = now() WHERE id = %s", (event_id,))
        db.commit()
    resp = api.patch(
        f"/api/admin/events/{event_id}", json={"title": "Boundary"}, headers=admin_headers
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "EVENT_STARTED"


def test_admin_edit_uses_post_lock_time(
    clean_db: dict[str, str], api: TestClient, db: psycopg.Connection
) -> None:
    """The start crosses over while the edit waits for the event lock.

    A stale transaction-start timestamp would still see a future event
    and accept the edit; only a fresh post-lock reading rejects it.
    """
    import threading
    import time

    from fastapi.testclient import TestClient as _TestClient

    _ = clean_db
    admin_headers = _auth(_make_admin(api, db))
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO eventbook.events (id, title, description, starts_at, venue, total_seats) "
            "VALUES (%s, 'Crossing', 'Starts mid-wait.', now() + make_interval(secs => 2), 'Hall', 10) "
            "RETURNING id",
            (str(uuid.uuid4()),),
        )
        event_id = str(cur.fetchone()[0])
        db.commit()
    slot: dict = {}

    def attempt() -> None:
        try:
            peer = _TestClient(api.app)
            slot["response"] = peer.patch(
                f"/api/admin/events/{event_id}",
                json={"title": "Rewritten"},
                headers=admin_headers,
            )
        except Exception as exc:  # pragma: no cover - surfaced below
            slot["error"] = exc

    locker = psycopg.connect(clean_db["migration_url"].replace("+psycopg://", "://"))
    try:
        with locker.cursor() as lock_cur:
            lock_cur.execute(
                "SELECT id FROM eventbook.events WHERE id = %s FOR UPDATE", (event_id,)
            )
            worker = threading.Thread(target=attempt)
            worker.start()
            time.sleep(3)  # the start time passes while the edit waits
            locker.commit()  # release the lock without touching the event
            worker.join(timeout=20)
            assert not worker.is_alive()
            assert "error" not in slot
            assert slot["response"].status_code == 409
            assert slot["response"].json()["error"]["code"] == "EVENT_STARTED"
    finally:
        locker.close()
    with db.cursor() as cur:
        (title,) = cur.execute(
            "SELECT title FROM eventbook.events WHERE id = %s", (event_id,)
        ).fetchone()
        assert title == "Crossing"

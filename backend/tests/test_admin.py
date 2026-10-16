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
    admin_headers = _auth(admin)
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
    body = api.get("/api/admin/events", headers=admin_headers).json()
    assert body["total"] == 2
    assert {i["title"] for i in body["items"]} == {"Gala Future", "Gala Past"}
    assert set(body) == {"items", "page", "page_size", "total"}
    searched = api.get("/api/admin/events", params={"q": "gala"}, headers=admin_headers).json()
    assert searched["total"] == 2
    public = api.get("/api/events", params={"q": "gala"}).json()
    assert public["total"] == 1


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
    assert low.json()["error"]["code"] == "CAPACITY_BELOW_BOOKINGS"
    equal = api.patch(
        f"/api/admin/events/{event_id}", json={"total_seats": 2}, headers=admin_headers
    )
    assert equal.status_code == 200


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

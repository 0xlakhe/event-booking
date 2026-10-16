"""Isolated PostgreSQL test harness.

The test target is FIXED (name and roles are constants, never environment
configuration): only `eventbook_test` with its dedicated test roles is ever
touched. The guard validates URL parsing, then the live connection
destination (`current_database()`) and role (`current_user`) before any
migration or cleanup runs. Never touches development data.
"""

import os
from urllib.parse import urlparse

import psycopg
import pytest
from alembic import command as alembic_command
from alembic.config import Config as AlembicConfig

BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Fixed isolated target. Deliberately not configurable: trusting an
# environment override here would let a development URL pass validation
# before destructive cleanup runs.
FIXED_TEST_DATABASE = "eventbook_test"
FIXED_TEST_MIGRATION_ROLE = "eventbook_test_migrator"
FIXED_TEST_RUNTIME_ROLE = "eventbook_test_runtime"


def _required(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"{name} is required to run the test suite")
    return value


def db_name_of(url: str) -> str:
    return urlparse(url.replace("+psycopg://", "://")).path.lstrip("/")


def _url_user(url: str) -> str | None:
    return urlparse(url.replace("+psycopg://", "://")).username


def require_test_urls() -> tuple[str, str]:
    """Return (migration_url, runtime_url) or refuse before any DB work.

    Checks the parsed database name AND the embedded role username against
    the fixed isolated target. Environment overrides of the test database
    name are ignored: only `eventbook_test` with its dedicated roles passes.
    """
    migration_url = _required("TEST_MIGRATION_DATABASE_URL")
    runtime_url = _required("TEST_DATABASE_URL")
    for label, url, role in (
        ("TEST_MIGRATION_DATABASE_URL", migration_url, FIXED_TEST_MIGRATION_ROLE),
        ("TEST_DATABASE_URL", runtime_url, FIXED_TEST_RUNTIME_ROLE),
    ):
        if db_name_of(url) != FIXED_TEST_DATABASE:
            raise RuntimeError(
                f"Refusing {label}: targets database {db_name_of(url)!r}, "
                f"expected isolated test database {FIXED_TEST_DATABASE!r}"
            )
        if _url_user(url) != role:
            raise RuntimeError(
                f"Refusing {label}: connects as role {_url_user(url)!r}, "
                f"expected test role {role!r}"
            )
    return migration_url, runtime_url


def _strip_dialect(url: str) -> str:
    return url.replace("+psycopg://", "://")


def validate_live_test_target(migration_url: str, runtime_url: str) -> None:
    """Confirm each connection reaches the fixed database as the fixed role.

    Read-only (two `SELECT current_database(), current_user` probes). Runs
    after URL parsing and before migrations or cleanup, so a misleading URL
    can never reach destructive work.
    """
    for url, role in (
        (migration_url, FIXED_TEST_MIGRATION_ROLE),
        (runtime_url, FIXED_TEST_RUNTIME_ROLE),
    ):
        with psycopg.connect(_strip_dialect(url), connect_timeout=5) as conn:
            with conn.cursor() as cur:
                row = cur.execute("SELECT current_database(), current_user").fetchone()
                database, user = row[0], row[1]
        if database != FIXED_TEST_DATABASE or user != role:
            raise RuntimeError(
                f"Refusing test target: connected to database {database!r} "
                f"as role {user!r}, expected {FIXED_TEST_DATABASE!r} "
                f"as {role!r}"
            )


def _alembic_upgrade(migration_url: str) -> None:
    cfg = AlembicConfig(os.path.join(BACKEND_ROOT, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(BACKEND_ROOT, "migrations"))
    old_migration_url = os.environ.get("MIGRATION_DATABASE_URL")
    old_runtime_role = os.environ.get("EVENTBOOK_RUNTIME_ROLE")
    os.environ["MIGRATION_DATABASE_URL"] = migration_url
    os.environ["EVENTBOOK_RUNTIME_ROLE"] = FIXED_TEST_RUNTIME_ROLE
    try:
        alembic_command.upgrade(cfg, "head")
    finally:
        if old_migration_url is None:
            os.environ.pop("MIGRATION_DATABASE_URL", None)
        else:
            os.environ["MIGRATION_DATABASE_URL"] = old_migration_url
        if old_runtime_role is None:
            os.environ.pop("EVENTBOOK_RUNTIME_ROLE", None)
        else:
            os.environ["EVENTBOOK_RUNTIME_ROLE"] = old_runtime_role


@pytest.fixture(scope="session")
def test_urls() -> dict[str, str]:
    migration_url, runtime_url = require_test_urls()
    validate_live_test_target(migration_url, runtime_url)
    _alembic_upgrade(migration_url)
    return {"migration_url": migration_url, "runtime_url": runtime_url}


@pytest.fixture()
def clean_db(test_urls: dict[str, str]) -> dict[str, str]:
    with psycopg.connect(_strip_dialect(test_urls["migration_url"]), autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "TRUNCATE eventbook.bookings, eventbook.sessions, "
                "eventbook.events, eventbook.users RESTART IDENTITY CASCADE"
            )
    yield test_urls

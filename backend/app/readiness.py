"""Database readiness probe (reads only; never migrates).

Owns the expected schema/tables/revision contract for `/health`.
Application assembly and route wiring stay in `app.main`.
"""

from sqlalchemy import text
from sqlalchemy.engine import Engine

EXPECTED_SCHEMA = "eventbook"
EXPECTED_TABLES = frozenset({"users", "sessions", "events", "bookings"})


def get_readiness(engine: Engine, expected_revision: str | None) -> tuple[bool, str | None]:
    """Check DB reachability, expected schema/tables, and Alembic revision.

    Returns (ready, actual_revision). Missing or incomplete schema, missing
    version row, or revision mismatch means not ready. Never raises for
    expected absence; unexpected driver errors also yield not-ready so the
    caller returns sanitized 503. Performs reads only; no migrations.
    """
    try:
        with engine.connect() as conn:
            schema = conn.execute(
                text(
                    "SELECT schema_name FROM information_schema.schemata "
                    "WHERE schema_name = 'eventbook'"
                )
            ).scalar()
            if schema != EXPECTED_SCHEMA:
                return False, None

            rows = conn.execute(
                text(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_schema = 'eventbook'"
                )
            ).scalars().all()
            if not EXPECTED_TABLES.issubset(set(rows or [])):
                return False, None

            actual: str | None = None
            # Version table may live in the private schema or in public so
            # readiness can read it without schema ownership (TASK-002 decides
            # final placement with a justified update here if it differs).
            # Check existence first: a failed SELECT would abort the
            # PostgreSQL transaction and poison the fallback query.
            location_rows = conn.execute(
                text(
                    "SELECT table_schema FROM information_schema.tables "
                    "WHERE table_name = 'alembic_version' "
                    "AND table_schema IN ('eventbook', 'public')"
                )
            ).scalars().all()
            locations = set(location_rows or [])
            version_schema = (
                "eventbook" if "eventbook" in locations
                else "public" if "public" in locations
                else None
            )
            if version_schema is None:
                return False, None
            versions = conn.execute(
                text(f"SELECT version_num FROM {version_schema}.alembic_version")
            ).scalars().all()
            if not versions:
                return False, None
            actual = versions[0]
            if expected_revision is not None and actual != expected_revision:
                return False, actual
            return True, actual
    except Exception:
        return False, None

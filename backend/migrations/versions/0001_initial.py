"""Initial schema: eventbook tables, indexes, and role grants.

Explicit, frozen definitions: this historical migration must never change,
even if app.models evolves later. New model changes require new migrations.
Grants give the runtime role least privilege: column-restricted INSERT on
users (role stays a server default the runtime cannot set, and UPDATE on
users is withheld entirely), full row access only where the API needs it,
and SELECT on the version row so readiness works without schema ownership.
No Supabase-only roles are referenced.
"""

import os
import re

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text
from sqlalchemy.dialects import postgresql

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None

_ROLE_RE = re.compile(r"[a-z_][a-z0-9_]*")


def _runtime_role() -> str:
    role = os.environ.get("EVENTBOOK_RUNTIME_ROLE", "eventbook_runtime")
    if not _ROLE_RE.fullmatch(role):
        raise ValueError(f"Refusing suspicious runtime role name: {role!r}")
    return role


def upgrade() -> None:
    runtime = _runtime_role()
    conn = op.get_bind()
    migrator = conn.execute(text("SELECT current_user")).scalar()
    if not _ROLE_RE.fullmatch(migrator):
        raise ValueError(f"Refusing suspicious migrator role name: {migrator!r}")

    op.execute(text("CREATE SCHEMA IF NOT EXISTS eventbook"))

    # Reset any default privileges left by a previous run first: after a
    # downgrade the entries survive, and recreated tables would otherwise
    # inherit full row access (e.g. UPDATE on users), defeating the
    # column-restricted grants below. Fresh defaults are set at the end.
    op.execute(
        text(
            f'ALTER DEFAULT PRIVILEGES FOR ROLE "{migrator}" IN SCHEMA eventbook '
            f'REVOKE ALL ON TABLES FROM "{runtime}"'
        )
    )

    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.Text, nullable=False, unique=True),
        sa.Column("password_hash", sa.Text, nullable=False),
        sa.Column("role", sa.Text, nullable=False, server_default=sa.text("'user'")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "char_length(email) > 0 AND char_length(email) <= 254 "
            "AND email = lower(email) AND email = btrim(email)",
            name="ck_users_email_normalized",
        ),
        sa.CheckConstraint("role IN ('user', 'admin')", name="ck_users_role"),
        schema="eventbook",
    )
    op.create_table(
        "sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("eventbook.users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("token_hash", sa.Text, nullable=False, unique=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("expires_at > created_at", name="ck_sessions_expiry"),
        schema="eventbook",
    )
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"], schema="eventbook")
    op.create_table(
        "events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("venue", sa.Text, nullable=False),
        sa.Column("total_seats", sa.Integer, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint("btrim(title) <> ''", name="ck_events_title"),
        sa.CheckConstraint("btrim(description) <> ''", name="ck_events_description"),
        sa.CheckConstraint("btrim(venue) <> ''", name="ck_events_venue"),
        sa.CheckConstraint("total_seats > 0", name="ck_events_total_seats"),
        schema="eventbook",
    )
    op.create_index(
        "ix_events_starts_at_id", "events", ["starts_at", "id"], schema="eventbook"
    )
    op.create_table(
        "bookings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("eventbook.users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "event_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("eventbook.events.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "cancelled_at IS NULL OR cancelled_at >= created_at",
            name="ck_bookings_cancelled_at",
        ),
        schema="eventbook",
    )
    op.create_index(
        "uq_bookings_user_event_active",
        "bookings",
        ["user_id", "event_id"],
        unique=True,
        schema="eventbook",
        postgresql_where=sa.text("cancelled_at IS NULL"),
    )
    op.create_index(
        "ix_bookings_user_created",
        "bookings",
        ["user_id", "created_at", "id"],
        schema="eventbook",
    )
    op.create_index("ix_bookings_event_id", "bookings", ["event_id"], schema="eventbook")

    op.execute(text("REVOKE ALL ON SCHEMA eventbook FROM PUBLIC"))
    op.execute(text(f'GRANT USAGE ON SCHEMA eventbook TO "{runtime}"'))

    # users: reads limited to auth/identity columns; creation restricted to
    # non-privilege columns so the server default supplies role='user'.
    # No UPDATE at all: the runtime cannot promote anyone to admin.
    op.execute(
        text(
            f'GRANT SELECT (id, email, password_hash, role, created_at) '
            f'ON eventbook.users TO "{runtime}"'
        )
    )
    op.execute(text(f'GRANT INSERT (id, email, password_hash) ON eventbook.users TO "{runtime}"'))

    op.execute(text(f'GRANT SELECT, INSERT, DELETE ON eventbook.sessions TO "{runtime}"'))
    op.execute(text(f'GRANT SELECT, INSERT, UPDATE, DELETE ON eventbook.events TO "{runtime}"'))
    op.execute(text(f'GRANT SELECT, INSERT ON eventbook.bookings TO "{runtime}"'))
    # Cancellation flips cancelled_at only; history columns stay immutable.
    op.execute(text(f'GRANT UPDATE (cancelled_at) ON eventbook.bookings TO "{runtime}"'))

    op.execute(text("REVOKE ALL ON ALL TABLES IN SCHEMA eventbook FROM PUBLIC"))
    # Version row lives in this schema (the migrator cannot CREATE in
    # public). Readiness needs SELECT on this row only, never writes:
    # default privileges below would otherwise grant it full row access.
    op.execute(
        text(
            "DO $$ BEGIN "
            "IF EXISTS (SELECT FROM information_schema.tables "
            "WHERE table_schema = 'eventbook' AND table_name = 'alembic_version') THEN "
            f'GRANT SELECT ON eventbook.alembic_version TO "{runtime}"; '
            f'REVOKE INSERT, UPDATE, DELETE ON eventbook.alembic_version FROM "{runtime}"; '
            "END IF; END $$"
        )
    )

    op.execute(
        text(
            f'ALTER DEFAULT PRIVILEGES FOR ROLE "{migrator}" IN SCHEMA eventbook '
            f'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "{runtime}"'
        )
    )


def downgrade() -> None:
    # Drop app tables only (dependency order). The schema and version row
    # stay: Alembic deletes its version row after this runs, which requires
    # the version table to still exist.
    op.drop_table("bookings", schema="eventbook")
    op.drop_table("sessions", schema="eventbook")
    op.drop_table("events", schema="eventbook")
    op.drop_table("users", schema="eventbook")

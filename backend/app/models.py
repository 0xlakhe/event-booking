"""Table definitions for the private `eventbook` schema.

Mirrors `docs/TECHNICAL_DESIGN.md`: UUID keys generated backend-side,
timezone-aware timestamps defaulting to database time, text roles with
CHECK constraints (no enum workflow), and a partial unique index that
allows rebooking while old soft-cancelled rows remain compatible.

NOTE: `migrations/versions/0001_initial.py` holds frozen, explicit copies
of these definitions. This historical migration must never import these
models; never edit the initial migration. The application no longer writes
cancelled_at; old soft-cancelled rows remain excluded from history.
"""

import datetime
import uuid

from sqlalchemy import CheckConstraint, ForeignKey, Index, Text, text
from sqlalchemy import DateTime, Integer
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.sql import func
from sqlalchemy.dialects.postgresql import UUID


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(
            "char_length(email) > 0 AND char_length(email) <= 254 "
            "AND email = lower(email) AND email = btrim(email)",
            name="ck_users_email_normalized",
        ),
        CheckConstraint("role IN ('user', 'admin')", name="ck_users_role"),
        {"schema": "eventbook"},
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'user'"))
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Session(Base):
    __tablename__ = "sessions"
    __table_args__ = (
        CheckConstraint("expires_at > created_at", name="ck_sessions_expiry"),
        Index("ix_sessions_user_id", "user_id"),
        {"schema": "eventbook"},
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("eventbook.users.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    expires_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Event(Base):
    __tablename__ = "events"
    __table_args__ = (
        CheckConstraint("btrim(title) <> ''", name="ck_events_title"),
        CheckConstraint("btrim(description) <> ''", name="ck_events_description"),
        CheckConstraint("btrim(venue) <> ''", name="ck_events_venue"),
        CheckConstraint("total_seats > 0", name="ck_events_total_seats"),
        Index("ix_events_starts_at_id", "starts_at", "id"),
        {"schema": "eventbook"},
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    starts_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    venue: Mapped[str] = mapped_column(Text, nullable=False)
    total_seats: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class Booking(Base):
    __tablename__ = "bookings"
    __table_args__ = (
        CheckConstraint(
            "cancelled_at IS NULL OR cancelled_at >= created_at",
            name="ck_bookings_cancelled_at",
        ),
        Index(
            "uq_bookings_user_event_active",
            "user_id",
            "event_id",
            unique=True,
            postgresql_where=text("cancelled_at IS NULL"),
        ),
        Index("ix_bookings_user_created", "user_id", "created_at", "id"),
        Index("ix_bookings_event_id", "event_id"),
        {"schema": "eventbook"},
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("eventbook.users.id", ondelete="RESTRICT"), nullable=False
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("eventbook.events.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    cancelled_at: Mapped[datetime.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

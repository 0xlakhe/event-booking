"""Custom opaque-session authentication (TASK-003).

Hides hashing, sessions, and credential lookup behind a small interface:
routes and later tasks receive a plain `UserActor`, never a password hash
or session hash. Each resolution opens its own short read and closes it
before returning, so module-owned write transactions in later tasks start
with no open authentication transaction.
"""

import hashlib
import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from .config import Settings
from .db import get_engine
from .errors import ApiError
from .passwords import hash_password, verify_password

SESSION_TTL = timedelta(hours=24)
BEARER_CHALLENGE = {"WWW-Authenticate": "Bearer"}

# Verifies unknown-email logins in constant shape without a stored hash.
_DUMMY_HASH = hash_password("invalid-credentials-dummy-placeholder")

_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


def normalize_email(raw: str) -> str:
    """Trim and lowercase an email address (pure normalization)."""
    return raw.strip().lower()


def _checked_email(value: object) -> object:
    if isinstance(value, str):
        email = normalize_email(value)
        if not _EMAIL_RE.fullmatch(email):
            raise ValueError("Enter a valid email address.")
        return email
    return value


@dataclass(frozen=True)
class UserActor:
    """Authenticated caller: plain values safe to pass across transactions."""

    id: uuid.UUID
    email: str
    role: str


class RegisterInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("email", mode="before")
    @classmethod
    def _normalize_email(cls, value: object) -> object:
        return _checked_email(value)


class LoginInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("email", mode="before")
    @classmethod
    def _normalize_email(cls, value: object) -> object:
        return _checked_email(value)


class UserPublic(BaseModel):
    id: uuid.UUID
    email: str
    role: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str
    expires_at: str
    user: UserPublic


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def _bearer_token(request: Request) -> str | None:
    """Extract the bearer token, or None when the header is absent/malformed."""
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


def get_current_user(request: Request) -> UserActor:
    """Resolve the bearer session to an actor; 401 when missing/invalid."""
    settings: Settings = request.app.state.settings
    token = _bearer_token(request)
    if token is None:
        raise ApiError(401, "AUTH_REQUIRED", "Authentication required.", BEARER_CHALLENGE)
    try:
        token_hash = _hash_token(token)
    except UnicodeEncodeError:
        # Non-ASCII bytes can never match a stored URL-safe token: controlled
        # 401, never a 500 from the encoder.
        raise ApiError(
            401, "INVALID_SESSION", "Invalid or expired session.", BEARER_CHALLENGE
        ) from None
    engine = get_engine(settings)
    with engine.connect() as conn:
        row = conn.execute(
            text(
                "SELECT u.id, u.email, u.role FROM eventbook.sessions s "
                "JOIN eventbook.users u ON u.id = s.user_id "
                "WHERE s.token_hash = :hash AND s.expires_at > now()"
            ),
            {"hash": token_hash},
        ).mappings().fetchone()
    if row is None:
        raise ApiError(401, "INVALID_SESSION", "Invalid or expired session.", BEARER_CHALLENGE)
    return UserActor(id=row["id"], email=row["email"], role=row["role"])


def require_admin(actor: UserActor = Depends(get_current_user)) -> UserActor:
    """Reject non-admin callers; backend role checks stay authoritative."""
    if actor.role != "admin":
        raise ApiError(403, "ADMIN_REQUIRED", "Administrator access required.")
    return actor


def require_non_admin(actor: UserActor = Depends(get_current_user)) -> UserActor:
    """Normal users only: admins are management-only and never book.

    Scope decision (not a PDF prohibition): booking, history, and
    cancellation serve normal users; administrators manage events and
    attendees instead. Runs after get_current_user, so anonymous callers
    still receive 401 before this 403.
    """
    if actor.role == "admin":
        raise ApiError(
            403,
            "ADMIN_BOOKING_FORBIDDEN",
            "Booking actions are not available to administrators.",
        )
    return actor


router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register", status_code=201, response_model=UserPublic)
def register(body: RegisterInput, request: Request) -> UserPublic:
    settings: Settings = request.app.state.settings
    email = body.email
    engine = get_engine(settings)
    try:
        with engine.begin() as conn:
            row = conn.execute(
                text(
                    "INSERT INTO eventbook.users (id, email, password_hash) "
                    "VALUES (:id, :email, :hash) "
                    "RETURNING id, email, role"
                ),
                {"id": str(uuid.uuid4()), "email": email, "hash": hash_password(body.password)},
            ).mappings().fetchone()
    except IntegrityError as exc:
        orig = getattr(exc, "orig", None)
        state = getattr(orig, "pgcode", None) or getattr(orig, "sqlstate", None)
        if state != "23505":
            raise
        # Confirm the conflict is the email address, not a UUID collision.
        with engine.connect() as conn:
            taken = conn.execute(
                text("SELECT id FROM eventbook.users WHERE email = :email"),
                {"email": email},
            ).scalar()
        if taken is None:
            raise
        raise ApiError(409, "EMAIL_EXISTS", "An account with this email already exists.") from exc
    assert row is not None
    return UserPublic(id=row["id"], email=row["email"], role=row["role"])


@router.post("/login", response_model=LoginResponse)
def login(body: LoginInput, request: Request) -> LoginResponse:
    settings: Settings = request.app.state.settings
    email = body.email
    engine = get_engine(settings)
    with engine.connect() as conn:
        row = conn.execute(
            text(
                "SELECT id, email, password_hash, role FROM eventbook.users "
                "WHERE email = :email"
            ),
            {"email": email},
        ).mappings().fetchone()
    if row is None:
        verify_password(body.password, _DUMMY_HASH)
        raise ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password.", BEARER_CHALLENGE)
    if not verify_password(body.password, row["password_hash"]):
        raise ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password.", BEARER_CHALLENGE)
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + SESSION_TTL
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO eventbook.sessions (id, user_id, token_hash, expires_at) "
                "VALUES (:id, :user_id, :hash, :expires_at)"
            ),
            {
                "id": str(uuid.uuid4()),
                "user_id": str(row["id"]),
                "hash": _hash_token(token),
                "expires_at": expires_at,
            },
        )
    return LoginResponse(
        access_token=token,
        token_type="bearer",
        expires_at=expires_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        user=UserPublic(id=row["id"], email=row["email"], role=row["role"]),
    )


@router.get("/me", response_model=UserPublic)
def me(actor: UserActor = Depends(get_current_user)) -> UserPublic:
    return UserPublic(id=actor.id, email=actor.email, role=actor.role)


@router.post("/logout", status_code=204, response_model=None)
def logout(request: Request, actor: UserActor = Depends(get_current_user)) -> None:
    _ = actor
    settings: Settings = request.app.state.settings
    token = _bearer_token(request) or ""
    engine = get_engine(settings)
    with engine.begin() as conn:
        conn.execute(
            text("DELETE FROM eventbook.sessions WHERE token_hash = :hash"),
            {"hash": _hash_token(token)},
        )
    return None

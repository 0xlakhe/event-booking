"""Application assembly and route wiring.

Readiness rules live in `app.readiness`, auth behavior in `app.auth`,
public browsing in `app.events`, error shape in `app.errors`, and
failed-login throttling in `app.rate_limit`.
Startup never mutates schema.
"""

import logging

from fastapi import FastAPI, Request
from fastapi import Response as FastAPIResponse
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.exc import SQLAlchemyError

from . import admin, auth, bookings, events
from .config import Settings, get_settings
from .db import get_engine
from .errors import (
    ApiError,
    api_error_handler,
    database_error_handler,
    error_response,
    validation_error_handler,
)
from .readiness import get_readiness
from .rate_limit import SlidingWindowLimiter

log = logging.getLogger("eventbook")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    app = FastAPI(title="EventBook API")
    app.state.settings = settings
    app.state.login_limiter = SlidingWindowLimiter(
        limit=settings.login_rate_limit_attempts,
        window_seconds=float(settings.login_rate_limit_window_seconds),
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.origins(),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )
    app.add_exception_handler(ApiError, api_error_handler)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, validation_error_handler)  # type: ignore[arg-type]
    app.add_exception_handler(SQLAlchemyError, database_error_handler)  # type: ignore[arg-type]

    @app.middleware("http")
    async def no_store_private_responses(request: Request, call_next):  # type: ignore[no-untyped-def]
        """Mark private responses unstoreable: auth, own bookings, admin,
        and the booking creation endpoint (a private POST under the public
        events prefix) alike — success and error paths."""
        response = await call_next(request)
        path, method = request.url.path, request.method
        if path.startswith(("/api/auth", "/api/bookings", "/api/admin")) or (
            method == "POST" and path.startswith("/api/events/") and path.endswith("/bookings")
        ):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/health", response_model=None)
    @app.get("/api/health", response_model=None)
    def health() -> dict[str, object] | FastAPIResponse:
        try:
            engine = get_engine(settings)
            ready, _ = get_readiness(engine, settings.expected_alembic_revision)
            if not ready:
                return error_response(
                    503, "TEMPORARILY_UNAVAILABLE", "Service temporarily unavailable."
                )
            return {"status": "ok", "database": "connected", "schema": "ready"}
        except Exception:
            # Sanitized: never leak DSN, credentials, or driver details.
            log.exception("health check failed")
            return error_response(
                503, "TEMPORARILY_UNAVAILABLE", "Service temporarily unavailable."
            )

    app.include_router(auth.router)
    app.include_router(events.router)
    app.include_router(bookings.router)
    app.include_router(admin.router)

    return app


app = create_app()

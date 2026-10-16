"""Shared sanitized error envelope per TECHNICAL_DESIGN.md."""

import logging
from typing import Any

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

log = logging.getLogger("eventbook")


def error_envelope(code: str, message: str, fields: dict[str, str] | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if fields:
        body["error"]["fields"] = fields
    return body


def error_response(
    status: int,
    code: str,
    message: str,
    headers: dict[str, str] | None = None,
    fields: dict[str, str] | None = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content=error_envelope(code, message, fields),
        headers=headers,
    )


class ApiError(Exception):
    """Endpoint failure carrying an exact envelope (rendered, never logged)."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        headers: dict[str, str] | None = None,
        fields: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.headers = headers
        self.fields = fields


async def api_error_handler(request: Request, exc: ApiError) -> JSONResponse:
    _ = request
    return error_response(exc.status, exc.code, exc.message, headers=exc.headers, fields=exc.fields)


async def database_error_handler(request: Request, exc: SQLAlchemyError) -> JSONResponse:
    """Map database failures to the shared 503 envelope.

    IntegrityError paths that carry API meaning (duplicate email) are
    translated in-route before they can reach this handler. Only the
    exception class name is logged: SQLAlchemy error text carries the
    SQL statement and bound parameters (emails, hashes, tokens), which
    must never reach logs. Details stay out of the response as well.
    """
    _ = request
    log.error("database unavailable: %s", type(exc).__name__)
    return error_response(503, "TEMPORARILY_UNAVAILABLE", "Service temporarily unavailable.")


async def validation_error_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """Normalize body/query/path failures into the shared 422 envelope.

    Only field names and validator messages are reported; submitted values
    (passwords, tokens) never appear in the response.
    """
    _ = request
    fields: dict[str, str] = {}
    for err in exc.errors():
        loc = [str(part) for part in err.get("loc", ()) if str(part) not in ("body", "query", "path")]
        fields[".".join(loc) or "body"] = str(err.get("msg", "Invalid input."))
    return JSONResponse(
        status_code=422,
        content=error_envelope("VALIDATION_ERROR", "Invalid input.", fields or None),
    )

"""Shared Argon2id password hashing.

Used by the seed script now and by authentication in TASK-003.
Hashes are PHC strings; plaintext is never stored or logged.
"""

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    """Hash a password with Argon2id, returning the PHC-encoded string."""
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """Return True when the password matches the hash; False otherwise."""
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, ValueError, AttributeError):
        return False

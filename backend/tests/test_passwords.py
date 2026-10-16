"""Unit tests for the shared Argon2id password helper (no database)."""

from app.passwords import hash_password, verify_password


def test_roundtrip_verifies() -> None:
    assert verify_password("correct horse 9!", hash_password("correct horse 9!")) is True


def test_wrong_password_fails() -> None:
    assert verify_password("wrong", hash_password("right")) is False


def test_hash_is_not_plaintext_and_is_salted() -> None:
    first = hash_password("same-password")
    second = hash_password("same-password")
    assert "same-password" not in first
    assert first != second
    assert first.startswith("$argon2id$")


def test_malformed_hash_fails_safely() -> None:
    assert verify_password("anything", "not-a-hash") is False

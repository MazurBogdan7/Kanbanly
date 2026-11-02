"""Случайные токены (в БД только хэш) и шифрование секретов TOTP."""

import base64
import hashlib
import os
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_recovery_code() -> str:
    raw = secrets.token_hex(5).upper()
    return f"{raw[:5]}-{raw[5:]}"


def _key(secret_key: str) -> bytes:
    return hashlib.sha256(f"totp:{secret_key}".encode()).digest()


def encrypt_secret(secret_key: str, value: str) -> str:
    nonce = os.urandom(12)
    ciphertext = AESGCM(_key(secret_key)).encrypt(nonce, value.encode(), None)
    return base64.urlsafe_b64encode(nonce + ciphertext).decode()


def decrypt_secret(secret_key: str, value: str) -> str:
    raw = base64.urlsafe_b64decode(value)
    return AESGCM(_key(secret_key)).decrypt(raw[:12], raw[12:], None).decode()

"""Шифрование бэкапа: AES-256-GCM, ключ из пароля через scrypt."""

import base64
import os
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

from app.core.errors import ApiError
from app.schemas.backup import BACKUP_VERSION, ENCRYPTED_FORMAT, EncryptedBackup

KDF_N = 1 << 15
KDF_R = 8
KDF_P = 1
KEY_BYTES = 32


def _derive(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return Scrypt(salt=salt, length=KEY_BYTES, n=n, r=r, p=p).derive(password.encode())


def _aad(n: int, r: int, p: int) -> bytes:
    # Параметры KDF подмешаны в тег: подмена заголовка обнаруживается при расшифровке.
    return f"{ENCRYPTED_FORMAT}:{BACKUP_VERSION}:{n}:{r}:{p}".encode()


def encrypt(plaintext: bytes, password: str) -> dict[str, Any]:
    salt = os.urandom(16)
    nonce = os.urandom(12)
    key = _derive(password, salt, KDF_N, KDF_R, KDF_P)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, _aad(KDF_N, KDF_R, KDF_P))
    return {
        "format": ENCRYPTED_FORMAT,
        "version": BACKUP_VERSION,
        "cipher": "AES-256-GCM",
        "kdf_params": {"algorithm": "scrypt", "n": KDF_N, "r": KDF_R, "p": KDF_P},
        "salt": base64.b64encode(salt).decode(),
        "nonce": base64.b64encode(nonce).decode(),
        "ciphertext": base64.b64encode(ciphertext).decode(),
    }


def decrypt(wrapper: EncryptedBackup, password: str) -> bytes:
    params = wrapper.kdf_params
    if params.n & (params.n - 1):
        raise ApiError(422, "corrupted_backup", "Файл бэкапа повреждён")
    try:
        salt = base64.b64decode(wrapper.salt, validate=True)
        nonce = base64.b64decode(wrapper.nonce, validate=True)
        ciphertext = base64.b64decode(wrapper.ciphertext, validate=True)
        key = _derive(password, salt, params.n, params.r, params.p)
        return AESGCM(key).decrypt(nonce, ciphertext, _aad(params.n, params.r, params.p))
    except InvalidTag as exc:
        raise ApiError(400, "wrong_password", "Неверный пароль или файл повреждён") from exc
    except ValueError as exc:
        raise ApiError(422, "corrupted_backup", "Файл бэкапа повреждён") from exc

"""CSRF (double submit) и заголовки безопасности. Чистый ASGI — без буферизации стримов."""

import hmac
import json
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

from starlette.datastructures import Headers, MutableHeaders
from starlette.requests import cookie_parser
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.config import Settings
from app.core.textguard import contains_bad_text

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
CSRF_HEADER = "x-csrf-token"

CSP = "; ".join(
    [
        "default-src 'self'",
        "script-src 'self'",
        # Radix и атрибут style нужны для темы доски; произвольный CSS из JSON сюда не попадает.
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self'",
        "img-src 'self' https: data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ]
)


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self.settings = settings

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                # Ответ с собственной, более строгой политикой (файлы документов) её сохраняет.
                if "content-security-policy" not in headers:
                    headers["Content-Security-Policy"] = CSP
                headers["X-Content-Type-Options"] = "nosniff"
                headers["X-Frame-Options"] = "DENY"
                headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
                headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=()"
                headers["Cross-Origin-Opener-Policy"] = "same-origin"
                if self.settings.env == "prod":
                    headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
                path: str = scope["path"]
                if path.startswith("/api/") and "cache-control" not in headers:
                    headers["Cache-Control"] = "no-store"
            await send(message)

        await self.app(scope, receive, send_wrapper)


class CSRFMiddleware:
    """Double submit: значение httpOnly=false-cookie дублируется в заголовке X-CSRF-Token."""

    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self.settings = settings

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not self._requires_check(scope):
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        cookies = cookie_parser(headers.get("cookie", ""))
        cookie_token = cookies.get(self.settings.csrf_cookie, "")
        header_token = headers.get(CSRF_HEADER, "")
        if cookie_token and header_token and hmac.compare_digest(cookie_token, header_token):
            await self.app(scope, receive, send)
            return
        await _send_json(send, 403, "csrf_failed", "Проверка CSRF не пройдена. Обновите страницу.")

    @staticmethod
    def _requires_check(scope: MutableMapping[str, Any]) -> bool:
        path: str = scope["path"]
        return scope["method"] not in SAFE_METHODS and path.startswith("/api/")


class BodyGuardMiddleware:
    """Общий лимит размера тела и отказ от текста, который не сохранится в БД."""

    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self.settings = settings

    def _limit(self, path: str) -> int:
        if path.startswith("/api/v1/import/") or path.endswith("/boards/import"):
            return self.settings.backup_max_bytes
        if path.endswith(("/documents", "/versions")):
            return self.settings.file_max_bytes
        return self.settings.template_max_bytes * 2

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            await self.app(scope, receive, send)
            return
        if b"%00" in scope.get("query_string", b""):
            await _send_json(send, 422, "invalid_text", "Текст содержит недопустимые символы")
            return
        if scope["method"] in SAFE_METHODS:
            await self.app(scope, receive, send)
            return
        limit = self._limit(scope["path"])
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] != "http.request":
                await self.app(scope, receive, send)
                return
            body += message.get("body", b"")
            if len(body) > limit:
                await _send_json(send, 413, "payload_too_large", "Запрос слишком большой")
                return
            if not message.get("more_body"):
                break
        if self._is_bad_json(scope, bytes(body)):
            await _send_json(send, 422, "invalid_text", "Текст содержит недопустимые символы")
            return
        delivered = False

        async def replay() -> Message:
            nonlocal delivered
            if delivered:
                return await receive()
            delivered = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, replay, send)

    @staticmethod
    def _is_bad_json(scope: Scope, body: bytes) -> bool:
        content_type = Headers(scope=scope).get("content-type", "")
        # Загрузки файлов (без JSON content-type) проверяются при разборе файла.
        if "json" not in content_type or b"\\u" not in body:
            return False
        try:
            return contains_bad_text(json.loads(body))
        except (ValueError, RecursionError):
            return False


async def _send_json(
    send: Callable[[Message], Awaitable[None]], status: int, code: str, message: str
) -> None:
    body = json.dumps({"error": {"code": code, "message": message, "details": None}}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        }
    )
    await send({"type": "http.response.body", "body": body})

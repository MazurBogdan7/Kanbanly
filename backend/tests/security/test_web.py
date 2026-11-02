import logging
from typing import Any

import pytest

from tests.conftest import STRONG_PASSWORD, Api, make_settings


async def test_csrf_required_for_mutations(client: Api) -> None:
    response = await client.http.post("/api/v1/auth/logout", headers={"X-CSRF-Token": "forged"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_failed"
    missing = await client.http.post("/api/v1/auth/logout")
    assert missing.status_code == 403
    assert (await client.get("/auth/me")).status_code == 200


async def test_csrf_not_required_for_reads(client: Api) -> None:
    assert (await client.http.get("/api/v1/auth/me")).status_code == 200


async def test_security_headers_present(anon: Api) -> None:
    headers = (await anon.get("/health")).headers
    csp = headers["content-security-policy"]
    script_src = next(part for part in csp.split(";") if "script-src" in part)
    assert "unsafe-inline" not in script_src and "unsafe-eval" not in script_src
    assert "object-src 'none'" in csp and "frame-ancestors 'none'" in csp
    assert headers["x-content-type-options"] == "nosniff"
    assert headers["referrer-policy"] == "strict-origin-when-cross-origin"
    assert "camera=()" in headers["permissions-policy"]
    assert "strict-transport-security" not in headers


async def test_hsts_in_prod(engine: Any) -> None:
    from app.main import create_app
    from app.services.mailer import MemoryMailer

    settings = make_settings(env="prod")
    app = create_app(settings, engine=engine, mailer=MemoryMailer())
    api = Api(app)
    assert "strict-transport-security" in (await api.get("/health")).headers
    assert (await api.get("/openapi.json")).status_code == 404
    await api.http.aclose()


def test_prod_refuses_default_secret() -> None:
    from app.core.config import INSECURE_DEV_KEY

    with pytest.raises(ValueError):
        make_settings(env="prod", secret_key=INSECURE_DEV_KEY)


@pytest.mark.parametrize(
    "overrides",
    [
        {"secret_key": "replace-with-output-of-openssl-rand-hex-32"},
        {"database_url": "postgresql+asyncpg://kanbanly:replace-with-strong-password@db/kanbanly"},
        {"cookie_secure": False},
    ],
)
def test_prod_refuses_placeholders(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        make_settings(env="prod", **overrides)


async def test_login_rate_limit(client: Api, anon: Api) -> None:
    payload = {"email": "alice@example.com", "password": "wrong-password-1"}
    for _ in range(5):
        assert (await anon.post("/auth/login", json=payload)).status_code == 401
    blocked = await anon.post("/auth/login", json=payload)
    assert blocked.status_code == 429
    assert blocked.headers["retry-after"] == "60"
    good = await anon.post("/auth/login", json={**payload, "password": STRONG_PASSWORD})
    assert good.status_code == 429, "блокировка действует и на верный пароль"


async def test_rate_limit_is_per_identity(client: Api, anon: Api) -> None:
    for _ in range(6):
        await anon.post("/auth/login", json={"email": "alice@example.com", "password": "wrong-password-1"})
    other = await anon.post("/auth/login", json={"email": "bob@example.com", "password": "wrong-password-1"})
    assert other.status_code == 401


async def test_register_and_reset_rate_limited(anon: Api) -> None:
    for _ in range(5):
        await anon.post("/auth/password-reset/request", json={"email": "a@example.com"})
    assert (
        await anon.post("/auth/password-reset/request", json={"email": "a@example.com"})
    ).status_code == 429
    for _ in range(5):
        await anon.post("/auth/register", json={"email": "b@example.com", "password": "short"})
    response = await anon.post("/auth/register", json={"email": "b@example.com", "password": "short"})
    assert response.status_code == 429


async def test_secrets_never_reach_logs(anon: Api, caplog: pytest.LogCaptureFixture) -> None:
    from app.core.logging import install_redaction

    root = logging.getLogger()
    install_redaction(root)
    caplog.handler.addFilter(next(f for f in root.filters))
    email = "secret.person@example.com"
    with caplog.at_level(logging.DEBUG):
        await anon.post("/auth/register", json={"email": email, "password": STRONG_PASSWORD})
        await anon.post("/auth/login", json={"email": email, "password": STRONG_PASSWORD})
        await anon.post("/auth/password-reset/request", json={"email": email})
        logging.getLogger("app.probe").info("login attempt %s password=%s", email, STRONG_PASSWORD)
    text = caplog.text
    assert email not in text
    assert STRONG_PASSWORD not in text


async def test_error_format_is_uniform(anon: Api) -> None:
    missing = await anon.get("/no-such-route")
    assert set(missing.json()["error"]) == {"code", "message", "details"}
    invalid = await anon.post("/auth/login", json={"email": "bad"})
    error = invalid.json()["error"]
    assert error["code"] == "validation_error"
    assert {item["path"] for item in error["details"]} >= {"email", "password"}


@pytest.mark.parametrize("bad", ['"nul\\u0000"', '"lone\\ud800"', '"low\\udc00"'])
async def test_unstorable_text_rejected_in_json_body(client: Api, bad: str) -> None:
    body = '{"name": ' + bad + "}"
    response = await client.post("/projects", content=body, headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_text"


async def test_valid_emoji_escape_and_literal_backslash_u_accepted(client: Api) -> None:
    body = '{"name": "\\ud83d\\ude00 и \\\\u0000"}'
    response = await client.post("/projects", content=body, headers={"Content-Type": "application/json"})
    assert response.status_code == 201, response.text
    assert response.json()["name"] == "😀 и \\u0000"


async def test_nul_in_query_rejected(client: Api) -> None:
    response = await client.get("/search?q=a%00b")
    assert response.status_code == 422


async def test_nul_in_uploaded_files_rejected(client: Api) -> None:
    document = '{"meta": {"name": "x\\u0000"}, "columns": [{"key": "a", "name": "A"}]}'
    preview = await client.post("/templates/import/preview", content=document)
    assert preview.json()["valid"] is False
    assert (await client.post("/templates/import", content=document)).status_code == 422
    assert (await client.post("/import/backup", content='{"format": "x\\u0000"}')).status_code == 422


async def test_oversized_body_rejected(client: Api, settings: Any) -> None:
    payload = b"x" * (settings.template_max_bytes * 2 + 1)
    response = await client.post("/projects", content=payload)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"

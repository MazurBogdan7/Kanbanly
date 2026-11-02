import re
from datetime import timedelta
from typing import Any

import pyotp
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.db import utcnow
from app.models import AuditLog, PasswordResetToken, User, UserSession
from app.services.mailer import MemoryMailer
from tests.conftest import STRONG_PASSWORD, Api


async def test_health(anon: Api) -> None:
    response = await anon.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_register_sets_secure_session_cookie(anon: Api) -> None:
    response = await anon.post(
        "/auth/register", json={"email": "New@Example.com", "password": STRONG_PASSWORD}
    )
    assert response.status_code == 201
    assert response.json()["email"] == "new@example.com"
    set_cookie = next(h for h in response.headers.get_list("set-cookie") if h.startswith("kanbanly_session"))
    lowered = set_cookie.lower()
    assert "httponly" in lowered and "secure" in lowered and "samesite=lax" in lowered
    assert (await anon.get("/auth/me")).status_code == 200


async def test_register_rejects_weak_breached_duplicate(anon: Api, client: Api) -> None:
    weak = await anon.post("/auth/register", json={"email": "a@example.com", "password": "short"})
    assert weak.status_code == 422 and weak.json()["error"]["code"] == "weak_password"
    breached = await anon.post("/auth/register", json={"email": "a@example.com", "password": "qwertyuiop123"})
    assert breached.json()["error"]["code"] == "breached_password"
    duplicate = await anon.post(
        "/auth/register", json={"email": "ALICE@example.com", "password": STRONG_PASSWORD}
    )
    assert duplicate.status_code == 409


async def test_password_hash_never_exposed(client: Api, engine: AsyncEngine) -> None:
    body = (await client.get("/auth/me")).text
    assert "password" not in body and "argon2" not in body
    async with AsyncSession(engine) as session:
        user = (await session.execute(select(User))).scalars().first()
    assert user is not None and user.password_hash.startswith("$argon2id$")


async def test_login_rotates_session(client: Api, engine: AsyncEngine) -> None:
    old_cookie = client.http.cookies.get("kanbanly_session")
    response = await client.post(
        "/auth/login", json={"email": "alice@example.com", "password": STRONG_PASSWORD}
    )
    assert response.status_code == 200
    new_cookie = client.http.cookies.get("kanbanly_session")
    assert new_cookie and new_cookie != old_cookie
    async with AsyncSession(engine) as session:
        rows = (await session.execute(select(UserSession))).scalars().all()
    assert len(rows) == 1
    client.http.cookies.clear()
    client.http.cookies.set("kanbanly_session", old_cookie or "")
    assert (await client.get("/auth/me")).status_code == 401, "старый идентификатор не должен работать"


async def test_login_errors_do_not_reveal_accounts(client: Api, anon: Api) -> None:
    wrong = await anon.post("/auth/login", json={"email": "alice@example.com", "password": "x" * 12})
    unknown = await anon.post("/auth/login", json={"email": "ghost@example.com", "password": "x" * 12})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()


async def test_logout_invalidates_session(client: Api) -> None:
    assert (await client.post("/auth/logout")).status_code == 200
    assert (await client.get("/auth/me")).status_code == 401


async def test_logout_all(client: Api, app: Any) -> None:
    second = Api(app)
    login = {"email": "alice@example.com", "password": STRONG_PASSWORD}
    assert (await second.post("/auth/login", json=login)).status_code == 200
    sessions = (await client.get("/auth/sessions")).json()
    assert len(sessions) == 2 and sum(s["current"] for s in sessions) == 1
    assert (await client.post("/auth/logout-all")).status_code == 200
    assert (await second.get("/auth/me")).status_code == 401
    await second.http.aclose()


async def test_revoke_single_session(client: Api, app: Any) -> None:
    second = Api(app)
    await second.post("/auth/login", json={"email": "alice@example.com", "password": STRONG_PASSWORD})
    target = next(s for s in (await client.get("/auth/sessions")).json() if not s["current"])
    assert (await client.delete(f"/auth/sessions/{target['id']}")).status_code == 200
    assert (await second.get("/auth/me")).status_code == 401
    assert (await client.delete(f"/auth/sessions/{target['id']}")).status_code == 404
    await second.http.aclose()


async def test_idle_timeout(client: Api, engine: AsyncEngine) -> None:
    async with AsyncSession(engine) as session:
        await session.execute(update(UserSession).values(last_seen_at=utcnow() - timedelta(days=8)))
        await session.commit()
    assert (await client.get("/auth/me")).status_code == 401


async def test_update_profile(client: Api) -> None:
    response = await client.patch("/auth/me", json={"display_name": "Алиса", "locale": "en"})
    assert response.json()["display_name"] == "Алиса" and response.json()["locale"] == "en"


async def test_change_password_revokes_others(client: Api, app: Any, anon: Api) -> None:
    second = Api(app)
    await second.post("/auth/login", json={"email": "alice@example.com", "password": STRONG_PASSWORD})
    bad = await client.post(
        "/auth/password", json={"current_password": "nope-nope-nope", "new_password": "another-good-pass-9"}
    )
    assert bad.status_code == 400
    good = await client.post(
        "/auth/password", json={"current_password": STRONG_PASSWORD, "new_password": "another-good-pass-9"}
    )
    assert good.status_code == 200
    assert (await client.get("/auth/me")).status_code == 200
    assert (await second.get("/auth/me")).status_code == 401
    await second.http.aclose()


async def test_password_reset_flow(client: Api, anon: Api, mailer: MemoryMailer, engine: AsyncEngine) -> None:
    assert (
        await anon.post("/auth/password-reset/request", json={"email": "ghost@example.com"})
    ).status_code == 202
    assert mailer.sent == []
    assert (
        await anon.post("/auth/password-reset/request", json={"email": "alice@example.com"})
    ).status_code == 202
    match = re.search(r"token=([\w\-]+)", mailer.sent[0]["body"])
    assert match
    token = match.group(1)

    async with AsyncSession(engine) as session:
        row = (await session.execute(select(PasswordResetToken))).scalars().one()
        assert row.token_hash != token
        assert timedelta(minutes=29) < row.expires_at - utcnow() <= timedelta(minutes=30)

    new_password = "fresh-password-after-reset"
    confirm = await anon.post(
        "/auth/password-reset/confirm", json={"token": token, "new_password": new_password}
    )
    assert confirm.status_code == 200
    assert (await client.get("/auth/me")).status_code == 401, "сброс завершает все сессии"
    reuse = await anon.post(
        "/auth/password-reset/confirm", json={"token": token, "new_password": new_password}
    )
    assert reuse.status_code == 400
    login = await anon.post("/auth/login", json={"email": "alice@example.com", "password": new_password})
    assert login.status_code == 200


async def test_mail_failure_does_not_reveal_account(
    client: Api, anon: Api, mailer: MemoryMailer, monkeypatch: Any
) -> None:
    async def broken(*_: Any) -> None:
        raise OSError("smtp down")

    monkeypatch.setattr(mailer, "send", broken)
    known = await anon.post("/auth/password-reset/request", json={"email": "alice@example.com"})
    unknown = await anon.post("/auth/password-reset/request", json={"email": "ghost@example.com"})
    assert known.status_code == unknown.status_code == 202
    assert known.json() == unknown.json()


async def test_reset_token_expires(client: Api, anon: Api, mailer: MemoryMailer, engine: AsyncEngine) -> None:
    await anon.post("/auth/password-reset/request", json={"email": "alice@example.com"})
    token = re.search(r"token=([\w\-]+)", mailer.sent[0]["body"]).group(1)  # type: ignore[union-attr]
    async with AsyncSession(engine) as session:
        await session.execute(update(PasswordResetToken).values(expires_at=utcnow() - timedelta(minutes=1)))
        await session.commit()
    response = await anon.post(
        "/auth/password-reset/confirm", json={"token": token, "new_password": "fresh-password-after-reset"}
    )
    assert response.status_code == 400


async def _enable_totp(client: Api) -> tuple[str, list[str]]:
    secret = (await client.post("/auth/2fa/setup")).json()["secret"]
    bad = await client.post("/auth/2fa/enable", json={"code": "000000"})
    assert bad.status_code == 400
    enabled = await client.post("/auth/2fa/enable", json={"code": pyotp.TOTP(secret).now()})
    assert enabled.status_code == 200
    return secret, enabled.json()["recovery_codes"]


async def test_totp_login_and_recovery(client: Api, anon: Api, engine: AsyncEngine) -> None:
    secret, codes = await _enable_totp(client)
    assert len(codes) == 10
    async with AsyncSession(engine) as session:
        user = (await session.execute(select(User))).scalars().one()
    assert user.totp_secret and secret not in user.totp_secret

    credentials = {"email": "alice@example.com", "password": STRONG_PASSWORD}
    need = await anon.post("/auth/login", json=credentials)
    assert need.status_code == 401 and need.json()["error"]["code"] == "totp_required"
    wrong = await anon.post("/auth/login", json={**credentials, "totp_code": "000000"})
    assert wrong.json()["error"]["code"] == "invalid_second_factor"
    good = await anon.post("/auth/login", json={**credentials, "totp_code": pyotp.TOTP(secret).now()})
    assert good.status_code == 200
    await anon.post("/auth/logout")

    first = await anon.post("/auth/login", json={**credentials, "recovery_code": codes[0]})
    assert first.status_code == 200
    await anon.post("/auth/logout")
    again = await anon.post("/auth/login", json={**credentials, "recovery_code": codes[0]})
    assert again.status_code == 401, "резервный код одноразовый"


async def test_totp_disable_requires_password(client: Api, anon: Api) -> None:
    await _enable_totp(client)
    assert (await client.post("/auth/2fa/disable", json={"password": "wrong-password"})).status_code == 400
    assert (await client.post("/auth/2fa/disable", json={"password": STRONG_PASSWORD})).status_code == 200
    login = await anon.post("/auth/login", json={"email": "alice@example.com", "password": STRONG_PASSWORD})
    assert login.status_code == 200


async def test_delete_account_removes_everything(client: Api, engine: AsyncEngine) -> None:
    wrong = await client.request("DELETE", "/auth/me", json={"password": "wrong-password"})
    assert wrong.status_code == 400
    response = await client.request("DELETE", "/auth/me", json={"password": STRONG_PASSWORD})
    assert response.status_code == 200
    assert (await client.get("/auth/me")).status_code == 401
    async with AsyncSession(engine) as session:
        assert (await session.execute(select(User))).first() is None
        assert (await session.execute(select(UserSession))).first() is None
        audit = (
            await session.execute(select(AuditLog).where(AuditLog.action == "auth.account_deleted"))
        ).scalar_one()
        assert audit.user_id is None


async def test_audit_log_written(client: Api, engine: AsyncEngine) -> None:
    await client.post("/auth/login", json={"email": "alice@example.com", "password": STRONG_PASSWORD})
    async with AsyncSession(engine) as session:
        actions = (await session.execute(select(AuditLog.action))).scalars().all()
    assert {"auth.register", "auth.login"} <= set(actions)


async def test_password_strength_endpoint(anon: Api) -> None:
    assert (await anon.post("/auth/password-strength", json={"password": "password123"})).json()["breached"]
    assert not (await anon.post("/auth/password-strength", json={"password": "zx81-kettle-moon"})).json()[
        "breached"
    ]

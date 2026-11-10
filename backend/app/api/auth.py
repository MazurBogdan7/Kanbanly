from uuid import UUID

from fastapi import APIRouter, Request, Response
from sqlalchemy import delete, func, select

from app.api.deps import (
    AppMailer,
    AppSettings,
    Current,
    Db,
    Limiter,
    clear_session_cookie,
    client_ip,
    set_csrf_cookie,
    set_session_cookie,
)
from app.core.errors import not_found
from app.models import User, UserSession
from app.schemas.auth import (
    CsrfOut,
    LoginIn,
    Ok,
    PasswordChangeIn,
    PasswordConfirmIn,
    ProfileUpdate,
    RecoveryCodesOut,
    RegisterIn,
    RegistrationOut,
    ResetConfirmIn,
    ResetRequestIn,
    SessionOut,
    TotpEnableIn,
    TotpSetupOut,
    UserOut,
)
from app.security import passwords
from app.security.tokens import new_token
from app.services import app_settings
from app.services import auth as service
from app.services.audit import audit

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/csrf")
def csrf(request: Request, response: Response, settings: AppSettings) -> CsrfOut:
    token = request.cookies.get(settings.csrf_cookie) or new_token()
    set_csrf_cookie(response, settings, token)
    return CsrfOut(csrf_token=token)


@router.get("/registration")
async def registration(db: Db) -> RegistrationOut:
    """Открыта ли регистрация: страница регистрации заранее объясняет, если нет."""
    users = await db.scalar(select(func.count(User.id)))
    return RegistrationOut(open=users == 0 or bool(await app_settings.get(db, "registration_open")))


@router.post("/password-strength")
def password_strength(payload: PasswordConfirmIn) -> dict[str, bool]:
    """Отдельно от регистрации: индикатор силы спрашивает только факт наличия в утечках."""
    return {"breached": passwords.is_breached(payload.password)}


@router.post("/register", status_code=201)
async def register(
    payload: RegisterIn, request: Request, response: Response, db: Db, settings: AppSettings, limiter: Limiter
) -> UserOut:
    ip = client_ip(request)
    limiter.hit(limiter.key("register", ip, payload.email))
    user = await service.register(db, payload.email, payload.password, payload.display_name)
    token = await service.create_session(db, user, request.headers.get("user-agent", ""), ip)
    set_session_cookie(response, settings, token)
    set_csrf_cookie(response, settings, new_token())
    audit(db, user.id, "auth.register", ip=ip)
    return UserOut.model_validate(user)


@router.post("/login")
async def login(
    payload: LoginIn, request: Request, response: Response, db: Db, settings: AppSettings, limiter: Limiter
) -> UserOut:
    ip = client_ip(request)
    key = limiter.key("login", ip, payload.email)
    limiter.hit(key)
    user = await service.authenticate(
        db, settings, payload.email, payload.password, payload.totp_code, payload.recovery_code
    )
    limiter.reset(key)
    # Ротация: старая сессия из cookie не переживает вход.
    previous = request.cookies.get(settings.session_cookie)
    if previous:
        await service.revoke_session_by_token(db, previous)
    token = await service.create_session(db, user, request.headers.get("user-agent", ""), ip)
    set_session_cookie(response, settings, token)
    set_csrf_cookie(response, settings, new_token())
    audit(db, user.id, "auth.login", ip=ip)
    return UserOut.model_validate(user)


@router.post("/logout")
async def logout(current: Current, response: Response, db: Db, settings: AppSettings) -> Ok:
    await service.revoke_session_by_token(db, current.token)
    clear_session_cookie(response, settings)
    return Ok()


@router.post("/logout-all")
async def logout_all(
    current: Current, request: Request, response: Response, db: Db, settings: AppSettings
) -> Ok:
    await service.revoke_all_sessions(db, current.id)
    clear_session_cookie(response, settings)
    audit(db, current.id, "auth.logout_all", ip=client_ip(request))
    return Ok()


@router.get("/me")
async def me(current: Current) -> UserOut:
    return UserOut.model_validate(current.user)


@router.patch("/me")
async def update_me(payload: ProfileUpdate, current: Current, db: Db) -> UserOut:
    if payload.username is not None:
        current.user.username = await service.set_username(db, current.user, payload.username)
    if payload.presence is not None:
        current.user.presence = payload.presence
    if payload.display_name is not None:
        current.user.display_name = payload.display_name
    if payload.locale is not None:
        current.user.locale = payload.locale
    return UserOut.model_validate(current.user)


@router.delete("/me")
async def delete_me(
    payload: PasswordConfirmIn,
    current: Current,
    request: Request,
    response: Response,
    db: Db,
    settings: AppSettings,
) -> Ok:
    audit(db, None, "auth.account_deleted", ip=client_ip(request), target_type="user", target_id=current.id)
    await service.delete_account(db, current.user, payload.password)
    clear_session_cookie(response, settings)
    return Ok()


@router.post("/password")
async def change_password(payload: PasswordChangeIn, current: Current, request: Request, db: Db) -> Ok:
    await service.change_password(
        db, current.user, payload.current_password, payload.new_password, current.session_id
    )
    audit(db, current.id, "auth.password_changed", ip=client_ip(request))
    return Ok()


@router.post("/password-reset/request", status_code=202)
async def password_reset_request(
    payload: ResetRequestIn,
    request: Request,
    db: Db,
    settings: AppSettings,
    mailer: AppMailer,
    limiter: Limiter,
) -> Ok:
    limiter.hit(limiter.key("reset", client_ip(request), payload.email))
    await service.request_password_reset(db, settings, mailer, payload.email)
    return Ok()


@router.post("/password-reset/confirm")
async def password_reset_confirm(payload: ResetConfirmIn, request: Request, db: Db, limiter: Limiter) -> Ok:
    ip = client_ip(request)
    limiter.hit(limiter.key("reset-confirm", ip, ""))
    user = await service.confirm_password_reset(db, payload.token, payload.new_password)
    audit(db, user.id, "auth.password_reset", ip=ip)
    return Ok()


@router.post("/2fa/setup")
async def totp_setup(current: Current, settings: AppSettings) -> TotpSetupOut:
    secret, uri = service.begin_totp_setup(settings, current.user)
    return TotpSetupOut(secret=secret, uri=uri)


@router.post("/2fa/enable")
async def totp_enable(
    payload: TotpEnableIn, current: Current, request: Request, db: Db, settings: AppSettings
) -> RecoveryCodesOut:
    codes = await service.enable_totp(db, settings, current.user, payload.code)
    audit(db, current.id, "auth.2fa_enabled", ip=client_ip(request))
    return RecoveryCodesOut(recovery_codes=codes)


@router.post("/2fa/disable")
async def totp_disable(payload: PasswordConfirmIn, current: Current, request: Request, db: Db) -> Ok:
    await service.disable_totp(db, current.user, payload.password)
    audit(db, current.id, "auth.2fa_disabled", ip=client_ip(request))
    return Ok()


@router.get("/sessions")
async def sessions(current: Current, db: Db) -> list[SessionOut]:
    result = await db.execute(
        select(UserSession).where(UserSession.user_id == current.id).order_by(UserSession.last_seen_at.desc())
    )
    return [
        SessionOut(
            id=row.id,
            created_at=row.created_at,
            last_seen_at=row.last_seen_at,
            user_agent=row.user_agent,
            ip=row.ip,
            current=row.id == current.session_id,
        )
        for row in result.scalars()
    ]


@router.delete("/sessions/{session_id}")
async def revoke_session(session_id: UUID, current: Current, db: Db) -> Ok:
    result = await db.execute(
        delete(UserSession).where(UserSession.id == session_id, UserSession.user_id == current.id)
    )
    if result.rowcount == 0:  # type: ignore[attr-defined]
        raise not_found()
    return Ok()

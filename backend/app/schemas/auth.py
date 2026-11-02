from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field

Password = Annotated[str, Field(max_length=256)]


class RegisterIn(BaseModel):
    email: EmailStr
    password: Password
    display_name: Annotated[str, Field(max_length=120)] = ""


class LoginIn(BaseModel):
    email: EmailStr
    password: Password
    totp_code: Annotated[str, Field(max_length=16)] | None = None
    recovery_code: Annotated[str, Field(max_length=32)] | None = None


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    email: str
    display_name: str
    locale: str
    totp_enabled: bool
    created_at: datetime


class ProfileUpdate(BaseModel):
    display_name: Annotated[str, Field(min_length=1, max_length=120)] | None = None
    locale: Annotated[str, Field(pattern=r"^(ru|en)$")] | None = None


class PasswordChangeIn(BaseModel):
    current_password: Password
    new_password: Password


class ResetRequestIn(BaseModel):
    email: EmailStr


class ResetConfirmIn(BaseModel):
    token: Annotated[str, Field(max_length=128)]
    new_password: Password


class PasswordConfirmIn(BaseModel):
    password: Password


class TotpSetupOut(BaseModel):
    secret: str
    uri: str


class TotpEnableIn(BaseModel):
    code: Annotated[str, Field(max_length=16)]


class RecoveryCodesOut(BaseModel):
    recovery_codes: list[str]


class SessionOut(BaseModel):
    id: UUID
    created_at: datetime
    last_seen_at: datetime
    user_agent: str
    ip: str
    current: bool


class CsrfOut(BaseModel):
    csrf_token: str


class Ok(BaseModel):
    ok: bool = True

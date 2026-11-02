"""Единый формат ошибок: { "error": { "code", "message", "details" } }."""

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException


class ApiError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        details: Any = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details
        self.headers = headers


def not_found() -> ApiError:
    # Сообщение одно на все случаи: нельзя отличить «нет» от «чужое».
    return ApiError(404, "not_found", "Не найдено")


def forbidden(message: str = "Недостаточно прав") -> ApiError:
    return ApiError(403, "forbidden", message)


def conflict(current_version: int) -> ApiError:
    return ApiError(
        409,
        "version_conflict",
        "Данные изменились в другой вкладке или у другого участника. Обновите страницу и повторите.",
        {"current_version": current_version},
    )


def unauthorized(message: str = "Требуется вход") -> ApiError:
    return ApiError(401, "unauthorized", message)


_MESSAGES = {
    "missing": "обязательное поле",
    "string_too_long": "слишком длинная строка",
    "string_too_short": "слишком короткая строка",
    "string_type": "ожидается строка",
    "int_type": "ожидается целое число",
    "int_parsing": "ожидается целое число",
    "bool_type": "ожидается true или false",
    "bool_parsing": "ожидается true или false",
    "float_type": "ожидается число",
    "float_parsing": "ожидается число",
    "list_type": "ожидается список",
    "dict_type": "ожидается объект",
    "model_type": "ожидается объект",
    "model_attributes_type": "ожидается объект",
    "literal_error": "недопустимое значение",
    "union_tag_invalid": "неизвестный тип",
    "union_tag_not_found": "не указан тип",
    "greater_than_equal": "значение слишком маленькое",
    "less_than_equal": "значение слишком большое",
    "too_long": "слишком много элементов",
    "too_short": "слишком мало элементов",
    "string_pattern_mismatch": "неверный формат",
    "url_parsing": "неверный URL",
    "url_scheme": "недопустимая схема URL",
    "uuid_parsing": "неверный идентификатор",
    "date_from_datetime_parsing": "неверная дата",
    "datetime_from_date_parsing": "неверная дата",
}


def format_loc(loc: tuple[int | str, ...]) -> str:
    """('columns', 3, 'color') → columns[3].color"""
    path = ""
    for part in loc:
        if isinstance(part, int):
            path += f"[{part}]"
        else:
            path += f".{part}" if path else str(part)
    return path


def format_validation_errors(errors: list[Any], skip_prefix: tuple[str, ...] = ()) -> list[dict[str, str]]:
    result = []
    for error in errors:
        loc = tuple(p for p in error["loc"] if p not in skip_prefix and not _is_union_tag(p))
        message = error.get("msg", "")
        if error["type"] == "value_error":
            message = message.removeprefix("Value error, ")
        else:
            message = _MESSAGES.get(error["type"], message)
        path = format_loc(loc)
        # Ошибки связей несут путь в тексте: приводим к единому виду path + message.
        if not path and ": " in message:
            path, _, message = message.partition(": ")
        result.append({"path": path, "message": message})
    return result


def _is_union_tag(part: int | str) -> bool:
    # Дискриминированные union добавляют в путь имя варианта — пользователю оно не нужно.
    return isinstance(part, str) and part.startswith(("function-", "tagged-union"))


def _body(code: str, message: str, details: Any = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details}}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(_body(exc.code, exc.message, exc.details), exc.status, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _request_validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        details = format_validation_errors(list(exc.errors()), skip_prefix=("body", "query", "path"))
        return JSONResponse(_body("validation_error", "Проверьте введённые данные", details), 422)

    @app.exception_handler(ValidationError)
    async def _model_validation(_: Request, exc: ValidationError) -> JSONResponse:
        details = format_validation_errors(list(exc.errors()))
        return JSONResponse(_body("validation_error", "Проверьте введённые данные", details), 422)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return JSONResponse(_body(code, str(exc.detail)), exc.status_code)

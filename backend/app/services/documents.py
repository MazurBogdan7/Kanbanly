"""Документы проекта: определение типа, безопасный просмотр, версии.

Тип файла определяется по содержимому, заявленный браузером Content-Type не используется:
иначе HTML можно выдать за картинку и выполнить в браузере. Word и Excel превращаются в HTML
на сервере и очищаются белым списком тегов; исходный файл в браузер как страница не попадает.
"""

import asyncio
import hashlib
import html
import io
import zipfile
from typing import Any
from urllib.parse import quote, unquote

import mammoth  # type: ignore[import-untyped]
import nh3
from openpyxl import load_workbook  # type: ignore[import-untyped]

from app.core.errors import ApiError

MAX_UNZIPPED = 200 * 1024 * 1024
MAX_ZIP_ENTRIES = 5000
MAX_PREVIEW_HTML = 5 * 1024 * 1024
MAX_PREVIEW_TEXT = 1024 * 1024
XLSX_ROWS = 300
XLSX_COLUMNS = 40

IMAGE_TYPES = {"png": "image/png", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}
TEXT_EXTENSIONS = {".txt", ".csv", ".json", ".log", ".yaml", ".yml", ".xml"}
MARKDOWN_EXTENSIONS = {".md", ".markdown"}

ALLOWED_TAGS = {
    "p", "br", "strong", "b", "em", "i", "u", "s", "sub", "sup", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "a", "table", "thead", "tbody", "tr", "th", "td", "img", "blockquote", "pre", "code",
    "hr", "span", "caption",
}  # fmt: skip
ALLOWED_ATTRIBUTES = {
    "a": {"href"},
    "img": {"src", "alt"},
    "td": {"colspan", "rowspan"},
    "th": {"colspan", "rowspan"},
}


def extension(filename: str) -> str:
    dot = filename.rfind(".")
    return filename[dot:].lower() if dot > 0 else ""


def decode_filename(header: str | None) -> str:
    name = unquote(header or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    name = "".join(char for char in name if char.isprintable())[:255]
    if not name:
        raise ApiError(422, "filename_required", "Не указано имя файла")
    return name


def _zip_is_safe(data: bytes) -> bool:
    """Защита от zip-бомбы: docx и xlsx — архивы, их размер в распакованном виде ограничен."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            return len(entries) <= MAX_ZIP_ENTRIES and sum(e.file_size for e in entries) <= MAX_UNZIPPED
    except zipfile.BadZipFile:
        return False


def detect_kind(filename: str, data: bytes) -> str:
    ext = extension(filename)
    if data.startswith(b"%PDF-"):
        return "pdf"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data.startswith(b"PK\x03\x04") and ext in {".docx", ".xlsx"}:
        return ext.removeprefix(".")
    if ext in TEXT_EXTENSIONS | MARKDOWN_EXTENSIONS:
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            return "file"
        return "markdown" if ext in MARKDOWN_EXTENSIONS else "text"
    return "file"


def _attribute_filter(tag: str, attribute: str, value: str) -> str | None:
    # Картинки только встроенные: внешняя картинка в документе — пиксель слежения.
    if tag == "img" and attribute == "src" and not value.lower().startswith("data:image/"):
        return None
    # data: допустим только для картинок, не для ссылок.
    if tag == "a" and attribute == "href" and value.lower().startswith("data:"):
        return None
    return value


def sanitize(markup: str) -> str:
    return nh3.clean(
        markup,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRIBUTES,
        url_schemes={"http", "https", "mailto", "data"},
        link_rel="noopener noreferrer",
        attribute_filter=_attribute_filter,
    )


def _docx_html(data: bytes) -> str:
    result = mammoth.convert_to_html(io.BytesIO(data))
    return sanitize(result.value)


def _xlsx_html(data: bytes) -> str:
    workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    parts: list[str] = []
    try:
        for sheet in workbook.worksheets:
            parts.append(f"<h3>{html.escape(sheet.title)}</h3><table><tbody>")
            for number, row in enumerate(sheet.iter_rows(values_only=True)):
                if number >= XLSX_ROWS:
                    parts.append(f"<tr><td>… показаны первые {XLSX_ROWS} строк</td></tr>")
                    break
                cells = "".join(
                    f"<td>{html.escape('' if value is None else str(value))}</td>"
                    for value in row[:XLSX_COLUMNS]
                )
                parts.append(f"<tr>{cells}</tr>")
            parts.append("</tbody></table>")
    finally:
        workbook.close()
    return sanitize("".join(parts))


def build_preview(kind: str, data: bytes) -> dict[str, Any]:
    """Готовый просмотр. Ошибка разбора не мешает загрузке: файл останется доступен для скачивания."""
    try:
        if kind in {"docx", "xlsx"}:
            if not _zip_is_safe(data):
                return {"kind": "none", "reason": "unsafe_archive"}
            markup = _docx_html(data) if kind == "docx" else _xlsx_html(data)
            if len(markup) > MAX_PREVIEW_HTML:
                return {"kind": "none", "reason": "too_large"}
            return {"kind": "html", "html": markup}
        if kind in {"text", "markdown"}:
            return {"kind": kind, "text": data[:MAX_PREVIEW_TEXT].decode("utf-8", errors="replace")}
        if kind == "pdf":
            return {"kind": "pdf"}
        if kind in IMAGE_TYPES:
            return {"kind": "image"}
    except Exception:
        return {"kind": "none", "reason": "unreadable"}
    return {"kind": "none", "reason": "unsupported"}


async def prepare(filename: str, data: bytes, max_bytes: int) -> tuple[str, str, dict[str, Any]]:
    if not data:
        raise ApiError(422, "empty_file", "Файл пустой")
    if len(data) > max_bytes:
        raise ApiError(413, "payload_too_large", f"Файл больше {max_bytes // (1024 * 1024)} МБ")
    kind = detect_kind(filename, data)
    # Разбор Word и Excel — тяжёлая синхронная работа: не держим цикл событий.
    preview = await asyncio.to_thread(build_preview, kind, data)
    return kind, hashlib.sha256(data).hexdigest(), preview


def content_headers(filename: str, kind: str, inline: bool) -> tuple[str, dict[str, str]]:
    """Встроенно отдаются только картинки; остальное — вложением с нейтральным типом."""
    show = inline and kind in IMAGE_TYPES
    media_type = IMAGE_TYPES.get(kind) or ("application/pdf" if kind == "pdf" else "application/octet-stream")
    ascii_name = filename.encode("ascii", "ignore").decode().replace('"', "") or "file"
    disposition = "inline" if show else "attachment"
    encoded = quote(filename)
    headers = {
        "Content-Disposition": f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded}",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, no-store",
    }
    return media_type, headers

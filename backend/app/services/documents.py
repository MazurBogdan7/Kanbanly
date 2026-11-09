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
# Картинки Word не вшиваются в HTML (иначе документ со скриншотами не помещается в просмотр):
# в разметке остаётся ссылка «kanbanly-image:N», а сам файл берётся из архива docx по запросу.
IMAGE_SCHEME = "kanbanly-image"
MAX_DOC_IMAGES = 500
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
    # Картинки только свои: внешняя картинка в документе — пиксель слежения.
    if tag == "img" and attribute == "src":
        lowered = value.lower()
        if not (lowered.startswith("data:image/") or lowered.startswith(f"{IMAGE_SCHEME}:")):
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
        url_schemes={"http", "https", "mailto", "data", IMAGE_SCHEME},
        link_rel="noopener noreferrer",
        attribute_filter=_attribute_filter,
    )


def _sniff_image(data: bytes) -> str | None:
    for kind, media_type in IMAGE_TYPES.items():
        if detect_kind(f"x.{kind}", data) == kind:
            return media_type
    return None


def _docx_html(data: bytes) -> tuple[str, list[dict[str, str]]]:
    """HTML без вшитых картинок и список картинок: отпечаток и тип для выдачи по запросу."""
    images: list[dict[str, str]] = []

    def convert(image: Any) -> dict[str, str]:
        alt = image.alt_text or ""
        if len(images) >= MAX_DOC_IMAGES:
            return {"alt": alt}
        try:
            with image.open() as stream:
                raw = stream.read()
        except Exception:
            return {"alt": alt}
        media_type = _sniff_image(raw)
        if media_type is None:
            # EMF, WMF, TIFF браузер не покажет — остаётся подпись.
            return {"alt": alt or "[рисунок]"}
        images.append({"sha256": hashlib.sha256(raw).hexdigest(), "type": media_type})
        return {"src": f"{IMAGE_SCHEME}:{len(images) - 1}", "alt": alt}

    result = mammoth.convert_to_html(io.BytesIO(data), convert_image=mammoth.images.img_element(convert))
    return sanitize(result.value), images


def docx_image(data: bytes, preview: dict[str, Any] | None, number: int) -> tuple[bytes, str] | None:
    """Картинка N из просмотра docx: ищется в архиве по отпечатку, тип проверяется по содержимому."""
    images = (preview or {}).get("images") or []
    if not 0 <= number < len(images) or not _zip_is_safe(data):
        return None
    wanted = images[number]
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for entry in archive.infolist():
            if entry.is_dir() or entry.file_size > MAX_UNZIPPED:
                continue
            raw = archive.read(entry)
            if hashlib.sha256(raw).hexdigest() == wanted.get("sha256"):
                media_type = _sniff_image(raw)
                return (raw, media_type) if media_type else None
    return None


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
            images: list[dict[str, str]] = []
            if kind == "docx":
                markup, images = _docx_html(data)
            else:
                markup = _xlsx_html(data)
            if len(markup) > MAX_PREVIEW_HTML:
                return {"kind": "none", "reason": "too_large"}
            return {"kind": "html", "html": markup, "images": images, "format": 2}
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
